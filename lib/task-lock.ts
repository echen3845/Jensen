import type {PoolClient} from "pg";
// Shared lock order for future TS/Rust workers: task advisory lock, queue/task, action.
export async function taskLock(client:PoolClient,id:string){
 await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["jensen-task:"+id]);
}
export async function assertFence(client:PoolClient,user:string,task:string,token?:string){
 if(!token)return;
 const row=await client.query("SELECT task_id FROM task_queue WHERE task_id=$1 AND user_id=$2 AND lease_token=$3 AND state='running' AND lease_until>now() FOR SHARE",[task,user,token]);
 if(!row.rowCount)throw Object.assign(new Error("Worker lease lost."),{code:"lease_lost"});
}
