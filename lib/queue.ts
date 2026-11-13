import {randomUUID} from "node:crypto";
import {ApiError} from "./api-errors";
import {transaction} from "./db";
import {taskLock} from "./task-lock";
export type Claim={taskId:string;userId:string;token:string;attempts:number;maxAttempts:number};
export async function enqueueTask(user:string,id:string){
 return transaction(async client=>{
  await taskLock(client,id);
  const task=(await client.query("SELECT status FROM tasks WHERE id=$1 AND user_id=$2 FOR UPDATE",[id,user])).rows[0];
  if(!task)throw new ApiError(404,"not_found","Task not found.");
  if(["succeeded","failed","cancelled"].includes(task.status))throw new ApiError(409,"task_terminal","This task has already finished.");
  const queue=(await client.query("SELECT state FROM task_queue WHERE task_id=$1 AND user_id=$2",[id,user])).rows[0];
  if(queue?.state==="running")throw new ApiError(409,"task_in_progress","Task is already running.");
  await client.query("INSERT INTO task_queue(task_id,user_id) VALUES($1,$2) ON CONFLICT(task_id) DO UPDATE SET state='pending',available_at=now(),lease_token=NULL,lease_until=NULL",[id,user]);
  await client.query("UPDATE tasks SET status='pending',updated_at=now() WHERE id=$1 AND user_id=$2",[id,user]);
 },user);
}
export async function wakeTask(client:import("pg").PoolClient,user:string,id:string){
 await client.query("UPDATE task_queue SET state='pending',available_at=now() WHERE task_id=$1 AND user_id=$2 AND state='waiting'",[id,user]);
 await client.query("UPDATE tasks SET status='pending',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='waiting-for-user'",[id,user]);
}
export async function claimTask():Promise<Claim|null>{
 return transaction(async client=>{
  const candidates=(await client.query("SELECT task_id FROM task_queue WHERE (state='pending' AND available_at<=now()) OR (state='running' AND lease_until<=now()) ORDER BY available_at,task_id LIMIT 10")).rows;
  for(const candidate of candidates){
   const locked=await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",["jensen-task:"+candidate.task_id]);
   if(!locked.rows[0].locked)continue;
   const row=(await client.query("SELECT * FROM task_queue WHERE task_id=$1 AND ((state='pending' AND available_at<=now()) OR (state='running' AND lease_until<=now())) FOR UPDATE SKIP LOCKED",[candidate.task_id])).rows[0];
   if(!row)continue;
   await client.query("SELECT set_config('jensen.user_id',$1,true)",[row.user_id]);
   const task=(await client.query("SELECT status,created_at FROM tasks WHERE id=$1 AND user_id=$2 FOR UPDATE",[row.task_id,row.user_id])).rows[0];
   const attempts=row.attempts+(row.state==="running"?1:0);
   if(!task||["succeeded","failed","cancelled"].includes(task.status)){
    await client.query("UPDATE task_queue SET state=$2,lease_token=NULL,lease_until=NULL WHERE task_id=$1",[row.task_id,task?.status||'cancelled']);continue;
   }
   if(attempts>=row.max_attempts||Date.now()-new Date(task.created_at).getTime()>86400000){
    await client.query("UPDATE task_queue SET state='failed',attempts=$2,lease_token=NULL,lease_until=NULL WHERE task_id=$1",[row.task_id,attempts]);
    await client.query("UPDATE tasks SET status='failed',error_code='retry_limit',updated_at=now() WHERE id=$1 AND user_id=$2",[row.task_id,row.user_id]);
    continue;
   }
   const token=randomUUID();
   await client.query("UPDATE task_queue SET state='running',lease_token=$2,lease_until=now()+interval '30 seconds',attempts=$3,runs=runs+1 WHERE task_id=$1",[row.task_id,token,attempts]);
   await client.query("UPDATE tasks SET status='running',result=NULL,error_code=NULL,updated_at=now() WHERE id=$1 AND user_id=$2",[row.task_id,row.user_id]);
   await client.query("INSERT INTO action_events(user_id,task_id,kind,data) VALUES($1,$2,'task_claimed',$3)",[row.user_id,row.task_id,{attempts,recovered:row.state==="running"}]);
   return{taskId:row.task_id,userId:row.user_id,token,attempts,maxAttempts:row.max_attempts};
  }
  return null;
 });
}
export async function leaseActive(claim:Claim){
 return transaction(async client=>{
  const result=await client.query("SELECT q.task_id FROM task_queue q JOIN tasks t ON t.id=q.task_id AND t.user_id=q.user_id WHERE q.task_id=$1 AND q.user_id=$2 AND q.lease_token=$3 AND q.state='running' AND q.lease_until>now() AND t.status<>'cancelled'",[claim.taskId,claim.userId,claim.token]);
  if(!result.rowCount)throw new ApiError(409,"lease_lost","Task lease lost or cancelled.");
 },claim.userId);
}
export async function heartbeat(claim:Claim){
 return transaction(async client=>{
  await taskLock(client,claim.taskId);
  const result=await client.query("UPDATE task_queue q SET lease_until=now()+interval '30 seconds' FROM tasks t WHERE q.task_id=$1 AND q.user_id=$2 AND q.lease_token=$3 AND q.state='running' AND q.lease_until>now() AND t.id=q.task_id AND t.user_id=q.user_id AND t.status<>'cancelled' RETURNING q.task_id",[claim.taskId,claim.userId,claim.token]);
  if(!result.rowCount)throw new ApiError(409,"lease_lost","Task lease lost or cancelled.");
 },claim.userId);
}
export async function finishClaim(claim:Claim,error?:unknown){
 return transaction(async client=>{
  await taskLock(client,claim.taskId);
  const queue=(await client.query("SELECT * FROM task_queue WHERE task_id=$1 AND user_id=$2 AND lease_token=$3 AND state='running' AND lease_until>now() FOR UPDATE",[claim.taskId,claim.userId,claim.token])).rows[0];
  if(!queue)return;
  const task=(await client.query("SELECT status,result FROM tasks WHERE id=$1 AND user_id=$2",[claim.taskId,claim.userId])).rows[0];
  if(!task)return;
  let state=task.status==="waiting-for-user"?"waiting":task.status;
  if(state==="waiting"&&task.result?.waitingActionId){
   const ready=await client.query("SELECT a.id FROM actions a WHERE a.id=$1 AND a.user_id=$2 AND a.task_id=$3 AND a.expires_at>now() AND (a.status='approved' OR (a.status='pending' AND a.effect NOT IN ('external-message','paid-cancellation','purchase','commitment') AND EXISTS(SELECT 1 FROM permission_grants g WHERE g.user_id=a.user_id AND g.tool=a.tool AND g.tool_version=a.tool_version AND g.argument_hash=a.argument_hash AND g.revoked_at IS NULL AND g.expires_at>now())))",[task.result.waitingActionId,claim.userId,claim.taskId]);
   if(ready.rowCount){
    state="pending";
    await client.query("UPDATE tasks SET status='pending',updated_at=now() WHERE id=$1 AND user_id=$2",[claim.taskId,claim.userId]);
   }
  }
  if(error&&state!=="cancelled"){
   const code=error instanceof ApiError?error.code:(error as {code?:string})?.code||"task_failed";
   const retryable=!(error instanceof ApiError)||["provider_rate_limited","provider_timeout","provider_unavailable","concurrency_limited","request_timeout","request_cancelled","worker_cancelled"].includes(code);
   const attempts=queue.attempts+1,retry=retryable&&attempts<queue.max_attempts;
   state=retry?"pending":"failed";
   await client.query("UPDATE task_queue SET attempts=$2,available_at=now()+($3::int*interval '1 second') WHERE task_id=$1",[claim.taskId,attempts,Math.min(60,2**attempts)]);
   const receipts=(await client.query("SELECT id,tool,status,result FROM actions WHERE user_id=$1 AND task_id=$2 ORDER BY created_at",[claim.userId,claim.taskId])).rows;
   await client.query("UPDATE tasks SET status=$3,error_code=$4,result=$5,updated_at=now() WHERE id=$1 AND user_id=$2 AND status<>'cancelled'",[claim.taskId,claim.userId,state,code,{summary:retry?"Task will retry within its retry limit.":"Task stopped. Review completed and uncertain receipts.",receipts,partial:true}]);
  }
  if(state==="running"){
   state="failed";
   await client.query("UPDATE tasks SET status='failed',error_code='incomplete_execution',updated_at=now() WHERE id=$1 AND user_id=$2 AND status<>'cancelled'",[claim.taskId,claim.userId]);
  }
  await client.query("UPDATE task_queue SET state=$2,lease_token=NULL,lease_until=NULL WHERE task_id=$1",[claim.taskId,state]);
  await client.query("INSERT INTO action_events(user_id,task_id,kind,data) VALUES($1,$2,'task_released',$3)",[claim.userId,claim.taskId,{state}]);
 },claim.userId);
}
