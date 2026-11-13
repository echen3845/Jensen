import {randomUUID} from "node:crypto";
import type {PoolClient} from "pg";
import {ApiError} from "./api-errors";
import {transaction} from "./db";
import {taskLock,assertFence} from "./task-lock";
import {wakeTask} from "./queue";
import {digest,argumentFingerprint,type Tool,type ToolContext} from "./tool-contracts";
import {containsSecret,safeData} from "./secrets";
const financial=new Set(["external-message","paid-cancellation","purchase","commitment"]);
type Action={
 id:string;user_id:string;task_id:string;action_key:string;tool:string;tool_version:number;
 arguments:unknown;argument_hash:string;action_hash:string;approval_nonce:string;live:boolean;
 status:string;expires_at:Date;result:unknown;effect:string;preview:string;execution_token?:string;
 required_permissions:string[];
};
export function actionHash(row:Pick<Action,"user_id"|"task_id"|"action_key"|"tool"|"tool_version"|"argument_hash"|"approval_nonce"|"effect"|"required_permissions">){
 return digest({v:1,owner:row.user_id,task:row.task_id,key:row.action_key,tool:row.tool,version:row.tool_version,
  arguments:row.argument_hash,nonce:row.approval_nonce,effect:row.effect,permissions:row.required_permissions});
}
const readOwn=(tool:Tool)=>tool.effect==="read"&&tool.approval==="read-own"&&tool.permissions.length>0&&tool.permissions.every(scope=>["preferences:read","tasks:read"].includes(scope));
async function grant(client:PoolClient,user:string,tool:Tool,argumentHash:string){
 if(financial.has(tool.effect))return false;
 const result=await client.query("SELECT id FROM permission_grants WHERE user_id=$1 AND tool=$2 AND tool_version=$3 AND argument_hash=$4 AND expires_at>now() AND revoked_at IS NULL FOR SHARE",[user,tool.name,tool.version,argumentHash]);
 return !!result.rowCount;
}
async function event(client:PoolClient,row:Action,kind:string,data:unknown={}){
 await client.query("INSERT INTO action_events(user_id,task_id,action_id,kind,data) VALUES($1,$2,$3,$4,$5)",[row.user_id,row.task_id,row.id,kind,safeData(data)]);
}
async function rowFor(client:PoolClient,user:string,id:string){
 const owner=(await client.query("SELECT task_id FROM actions WHERE id=$1 AND user_id=$2",[id,user])).rows[0];
 if(!owner)throw new ApiError(404,"not_found","Action not found.");
 await taskLock(client,owner.task_id);
 const row=(await client.query("SELECT *,expires_at>now() AS live FROM actions WHERE id=$1 AND user_id=$2 FOR UPDATE",[id,user])).rows[0] as Action|undefined;
 if(!row)throw new ApiError(404,"not_found","Action not found.");return row;
}
export async function prepareAction(context:ToolContext,key:string,tool:Tool,input:unknown){
 await context.assertActive();
 const args=tool.validate(input),encoded=JSON.stringify(args);
 if(Buffer.byteLength(encoded)>8192||containsSecret(encoded))throw new ApiError(400,"unsafe_arguments","Tool arguments contain unsupported or sensitive data.");
 const argumentHash=argumentFingerprint(tool,args);
 return transaction(async client=>{
  await taskLock(client,context.taskId);
  await assertFence(client,context.userId,context.taskId,context.leaseToken);
  const task=await client.query("SELECT id FROM tasks WHERE id=$1 AND user_id=$2 AND status NOT IN ('cancelled','failed','succeeded')",[context.taskId,context.userId]);
  if(!task.rowCount)throw new ApiError(409,"task_inactive","Task is no longer active.");
  const existing=(await client.query("SELECT * FROM actions WHERE user_id=$1 AND task_id=$2 AND action_key=$3",[context.userId,context.taskId,key])).rows[0] as Action|undefined;
  if(existing){if(existing.argument_hash!==argumentHash||existing.tool_version!==tool.version)throw new ApiError(409,"action_changed","Changed arguments need a new action and approval.");return existing;}
  const row={
   id:randomUUID(),user_id:context.userId,task_id:context.taskId,action_key:key,
   tool:tool.name,tool_version:tool.version,arguments:args,argument_hash:argumentHash,approval_nonce:randomUUID(),
   effect:tool.effect,required_permissions:tool.permissions,
   preview:tool.preview(args).slice(0,2048)
  };
  const status=readOwn(tool)?"approved":"pending";
  const result=await client.query("INSERT INTO actions(id,user_id,task_id,action_key,tool,tool_version,arguments,argument_hash,approval_nonce,action_hash,preview,effect,required_permissions,status,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now()+interval '10 minutes') RETURNING *",
   [row.id,row.user_id,row.task_id,row.action_key,row.tool,row.tool_version,row.arguments,row.argument_hash,row.approval_nonce,actionHash(row),row.preview,row.effect,JSON.stringify(row.required_permissions),status]);
  await event(client,result.rows[0],"action_prepared",{hash:result.rows[0].action_hash});
  return result.rows[0] as Action;
 },context.userId);
}
async function canDecide(client:PoolClient,user:string,task:string){
 const row=await client.query("SELECT id FROM tasks WHERE id=$1 AND user_id=$2 AND status NOT IN ('cancelled','failed','succeeded') FOR SHARE",[task,user]);
 if(!row.rowCount)throw new ApiError(409,"task_inactive","This task is no longer active.");
}
export async function approveAction(user:string,id:string,expectedHash:string){
 return transaction(async client=>{
  const row=await rowFor(client,user,id);
  await canDecide(client,user,row.task_id);
  if(row.action_hash!==expectedHash||row.status!=="pending"||!row.live)throw new ApiError(409,"stale_approval","Review the current action or renew its expired preview before approving.");
  await client.query("UPDATE actions SET status='approved' WHERE id=$1 AND user_id=$2",[id,user]);
  await event(client,row,"action_approved",{hash:expectedHash});
  await wakeTask(client,user,row.task_id);
  return row.task_id;
 },user);
}
export async function renewAction(user:string,id:string){
 return transaction(async client=>{
  const row=await rowFor(client,user,id);
  await canDecide(client,user,row.task_id);
  if(!["pending","revoked"].includes(row.status))throw new ApiError(409,"action_in_progress","This action cannot be renewed.");
  row.approval_nonce=randomUUID();row.action_hash=actionHash(row);
  await client.query("UPDATE actions SET status='pending',approval_nonce=$3,action_hash=$4,expires_at=now()+interval '10 minutes' WHERE id=$1 AND user_id=$2",[id,user,row.approval_nonce,row.action_hash]);
  await event(client,row,"approval_renewed",{hash:row.action_hash});return row.action_hash;
 },user);
}
export async function revokeAction(user:string,id:string){
 return transaction(async client=>{
  const row=await rowFor(client,user,id);
  if(!["pending","approved"].includes(row.status))throw new ApiError(409,"action_in_progress","Already-running actions cannot be undone by revoking approval.");
  await client.query("UPDATE actions SET status='revoked' WHERE id=$1 AND user_id=$2",[id,user]);
  await event(client,row,"approval_revoked");
 },user);
}
export async function createGrant(user:string,id:string,expectedHash:string,seconds:number){
 if(!Number.isSafeInteger(seconds)||seconds<1||seconds>86400)throw new ApiError(400,"invalid_expiry","Standing permissions last at most 24 hours.");
 return transaction(async client=>{
  const row=await rowFor(client,user,id);
  await canDecide(client,user,row.task_id);
  if(row.action_hash!==expectedHash||row.status!=="pending"||!row.live)throw new ApiError(409,"stale_approval","Review the current action first.");
  if(financial.has(row.effect))throw new ApiError(403,"one_time_required","External messages and financial commitments require one-time approval.");
  const result=await client.query("INSERT INTO permission_grants(user_id,tool,tool_version,argument_hash,expires_at) VALUES($1,$2,$3,$4,now()+($5::int*interval '1 second')) RETURNING id",[user,row.tool,row.tool_version,row.argument_hash,seconds]);
  await event(client,row,"standing_permission_created",{grantId:result.rows[0].id,seconds});
  await wakeTask(client,user,row.task_id);
  return result.rows[0].id as string;
 },user);
}
export async function revokeGrant(user:string,id:string){
 await transaction(async c=>{
  const result=await c.query("UPDATE permission_grants SET revoked_at=now() WHERE id=$1 AND user_id=$2 RETURNING id",[id,user]);
  if(!result.rowCount)throw new ApiError(404,"not_found","Permission not found.");
 },user);
}
export async function executeAction(context:ToolContext,actionId:string,tool:Tool){
 await context.assertActive();
 const token=randomUUID();
 const decision=await transaction(async client=>{
  const row=await rowFor(client,context.userId,actionId);
  await assertFence(client,context.userId,context.taskId,context.leaseToken);
  const task=await client.query("SELECT status FROM tasks WHERE id=$1 AND user_id=$2 FOR SHARE",[context.taskId,context.userId]);
  if(task.rows[0]?.status==="cancelled")throw new ApiError(409,"task_cancelled","Task cancelled.");
  if(row.task_id!==context.taskId||row.tool!==tool.name||row.tool_version!==tool.version||
    row.argument_hash!==argumentFingerprint(tool,tool.validate(row.arguments))||
    row.action_hash!==actionHash(row))throw new ApiError(409,"action_changed","Action identity or parameters changed.");
  if(row.status==="succeeded"||row.status==="failed")return{kind:"done" as const,row};
  if(row.status==="running"&&!tool.idempotent){
   await client.query("UPDATE actions SET status='uncertain' WHERE id=$1 AND user_id=$2",[row.id,context.userId]);
   await event(client,row,"action_uncertain");return{kind:"waiting" as const,row};
  }
  if(row.status==="revoked"||row.status==="uncertain")return{kind:"waiting" as const,row};
  if(!row.live){
   await client.query("UPDATE actions SET status='pending' WHERE id=$1 AND user_id=$2",[row.id,context.userId]);
   return{kind:"waiting" as const,row};
  }
  if(row.status==="pending"&&!readOwn(tool)&&!await grant(client,context.userId,tool,row.argument_hash))return{kind:"waiting" as const,row};
  await client.query("UPDATE actions SET status='running',execution_token=$3 WHERE id=$1 AND user_id=$2",[row.id,context.userId,token]);
  await event(client,row,"action_started");return{kind:"run" as const,row};
 },context.userId);
 if(decision.kind==="waiting")return{waiting:true,actionId,result:null,failed:false};
 if(decision.kind==="done")return{waiting:false,actionId,result:decision.row.result,failed:decision.row.status==="failed"};
 let result:unknown,failed=false,uncertain=false;
 try{await context.assertActive();result={trust:"untrusted-data",source:tool.name,data:safeData(await tool.execute(decision.row.arguments,{...context,idempotencyKey:decision.row.id}))};}
 catch(error){
  failed=true;
  uncertain=tool.effect!=="read"&&!(error instanceof ApiError&&[400,403,404,413,415].includes(error.status));
  result={error:uncertain?"action_uncertain":error instanceof ApiError?error.code:"tool_failed",completed:false,uncertain};
 }
 await transaction(async client=>{
  await taskLock(client,context.taskId);
  const updated=await client.query("UPDATE actions SET status=$4,result=$5 WHERE id=$1 AND user_id=$2 AND execution_token=$3 AND status='running' RETURNING id",[actionId,context.userId,token,uncertain?"uncertain":failed?"failed":"succeeded",result]);
  if(updated.rowCount)await event(client,decision.row,failed?"action_failed":"action_completed",result);
 },context.userId);
 return{waiting:uncertain,actionId,result,failed};
}
