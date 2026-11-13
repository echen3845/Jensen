import {randomUUID} from "node:crypto";
import {ApiError} from "./api-errors";
import {transaction} from "./db";
import {containsSecret} from "./secrets";
import {uuid} from "./store";
import {modelFor,runAgent} from "./agent";
import {tools} from "./tools";
import {withDeadline} from "./request-resources";
export async function taskFor(user:string,id:string){
 const task=await transaction(async c=>(await c.query("SELECT id,status,input,result,error_code,created_at,updated_at FROM tasks WHERE id=$1 AND user_id=$2",[uuid(id),user])).rows[0],user);
 if(!task)throw new ApiError(404,"not_found","Task not found.");
 const receipts=await transaction(async c=>(await c.query("SELECT id,tool,status,result FROM actions WHERE user_id=$1 AND task_id=$2 ORDER BY created_at",[user,id])).rows,user);
 return{...task,result:{...(task.result||{}),receipts}};
}
export async function newTask(user:string,prompt:string,requestId:string= randomUUID()){
 uuid(requestId);
 if(Buffer.byteLength(prompt)>8192||containsSecret(prompt))throw new ApiError(400,"unsafe_prompt","Task prompts must be bounded and must not contain credentials.");
 return transaction(async c=>{
  await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE",[user]);
  const existing=(await c.query("SELECT id,input FROM tasks WHERE user_id=$1 AND input->>'requestId'=$2",[user,requestId])).rows[0];
  if(existing){if(existing.input.prompt!==prompt)throw new ApiError(409,"task_conflict","Request identifier already used.");return{id:existing.id as string,created:false};}
  const id=randomUUID();
  await c.query("INSERT INTO tasks(id,user_id,input) VALUES($1,$2,$3)",[id,user,{v:1,prompt,requestId}]);
  return{id,created:true};
 },user);
}
export async function failTask(user:string,id:string,code:string){
 await transaction(async c=>{
  const receipts=(await c.query("SELECT id,tool,status,result FROM actions WHERE user_id=$1 AND task_id=$2 ORDER BY created_at",[user,id])).rows;
  await c.query("UPDATE tasks SET status='failed',error_code=$3,result=$4,updated_at=now() WHERE id=$1 AND user_id=$2 AND status<>'cancelled'",[id,user,code,{summary:"Task stopped before completion. Review actual receipts.",receipts,partial:true}]);
 },user);
}
export async function executeInline(user:string,id:string,signal:AbortSignal){
 await taskFor(user,id);
 const claimed=await transaction(async c=>{
  const row=await c.query("UPDATE tasks SET status='running',updated_at=now() WHERE id=$1 AND user_id=$2 AND (status IN ('pending','waiting-for-user') OR (status='running' AND updated_at<now()-interval '2 minutes')) RETURNING id",[id,user]);
  return !!row.rowCount;
 },user);
 if(!claimed)throw new ApiError(409,"task_in_progress","Task is already running or finished.");
 try{await withDeadline(signal,60000,s=>runAgent(user,id,tools,modelFor(user),s));}
 catch(error){
  await failTask(user,id,error instanceof ApiError?error.code:"task_failed");
  throw error;
 }
 return taskFor(user,id);
}
export async function cancelTask(user:string,id:string){
 await taskFor(user,id);
 await transaction(async c=>{
  await c.query("UPDATE tasks SET status='cancelled',updated_at=now() WHERE id=$1 AND user_id=$2 AND status NOT IN ('succeeded','failed','cancelled')",[id,user]);
  await c.query("UPDATE actions SET status='revoked' WHERE user_id=$1 AND task_id=$2 AND status IN ('pending','approved')",[user,id]);
  await c.query("INSERT INTO action_events(user_id,task_id,kind,data) VALUES($1,$2,'task_cancel_requested',$3)",[user,id,{note:"Completed actions remain recorded; cancellation does not undo them."}]);
 },user);
}
