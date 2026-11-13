import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from "vitest";
vi.unmock("../../lib/auth");vi.unmock("../../lib/store");vi.unmock("../../lib/quotas");
import {randomBytes,randomUUID} from "node:crypto";
import {database,migrate,closeDatabase} from "../../lib/db";
import {newTask,taskFor,cancelTask} from "../../lib/task-service";
import {claimTask,finishClaim,leaseActive} from "../../lib/queue";
import {processClaim,workOnce} from "../../lib/worker";
import {checkpoint,type AgentModel,type AgentState} from "../../lib/agent";
import {tools} from "../../lib/tools";
import {executeAction,approveAction,prepareAction} from "../../lib/actions";
import {hashToken} from "../../lib/auth";
import {POST as createTask} from "../../app/api/tasks/route";
import {ApiError} from "../../lib/api-errors";
import {reserveUsage,settleUsage} from "../../lib/quotas";
import {createResponse} from "../mocks/openai";
const owners:string[]=[];
beforeAll(async()=>{
 const url=process.env.TEST_DATABASE_URL;
 if(!url||!new URL(url).pathname.endsWith("_test"))throw new Error("Use an isolated test database.");
 process.env.DATABASE_URL=url;await migrate();
});
afterEach(async()=>{if(owners.length)await database().query("DELETE FROM tasks WHERE user_id=ANY($1::uuid[])",[owners]);});
afterAll(async()=>{
 const holds=await database().query("SELECT id FROM provider_leases WHERE user_id=ANY($1::uuid[]) AND state='pending'",[owners]);
 for(const row of holds.rows)await settleUsage(row.id,0);
 for(const id of owners)await database().query("DELETE FROM users WHERE id=$1",[id]);
 await closeDatabase();
});
async function owner(){const id=randomUUID();owners.push(id);await database().query("INSERT INTO users(id,issuer,subject) VALUES($1,'worker-test',$2)",[id,id]);return id;}
async function expired(id:string){await database().query("UPDATE task_queue SET lease_until=now()-interval '1 second' WHERE task_id=$1",[id]);}
async function claim(){const value=await claimTask();if(!value)throw new Error("Expected claim");return value;}
describe("durable PostgreSQL workers",()=>{
 it("returns 202 without provider work and continues after the browser request is gone",async()=>{
  const user=await owner(),token=randomBytes(32).toString("hex"),key=randomUUID();
  vi.stubEnv("APP_URL","http://localhost:3000");
  await database().query("INSERT INTO sessions VALUES($1,$2,now()+interval '1 hour')",[hashToken(token),user]);
  const controller=new AbortController();
  const request=()=>new Request("http://localhost:3000/api/tasks",{method:"POST",signal:controller.signal,headers:{
   cookie:"jensen.session="+token,origin:"http://localhost:3000","content-type":"application/json","idempotency-key":key,"x-jensen-user":user
  },body:JSON.stringify({prompt:"Say hello"})});
  const [a,b]=await Promise.all([createTask(request()),createTask(request())]);
  expect(a.status).toBe(202);expect(b.status).toBe(202);
  const id=(await a.json()).task.id;
  expect((await b.json()).task.id).toBe(id);
  controller.abort();
  expect((await taskFor(user,id)).status).toBe("pending");
  expect(createResponse).not.toHaveBeenCalled();
  await workOnce({model:async()=>({text:"Hello",calls:[]})});
  expect((await taskFor(user,id)).status).toBe("succeeded");
 });
 it("lets only one parallel worker claim a job",async()=>{
  const user=await owner();await newTask(user,"Fixture");
  const results=await Promise.all([claimTask(),claimTask()]);
  expect(results.filter(Boolean)).toHaveLength(1);
 });
 it("fences stale checkpoints and old worker completion after lease recovery",async()=>{
  const user=await owner(),task=await newTask(user,"Fixture"),first=await claim();
  await expired(task.id);const second=await claim();
  expect(first.token).not.toBe(second.token);
  const state=(await database().query("SELECT checkpoint FROM tasks WHERE id=$1",[task.id])).rows[0].checkpoint as AgentState;
  await expect(checkpoint(user,task.id,state,"running",undefined,first.token)).rejects.toMatchObject({status:409});
  await finishClaim(first,new Error("old worker failed"));
  expect((await database().query("SELECT lease_token FROM task_queue WHERE task_id=$1",[task.id])).rows[0].lease_token).toBe(second.token);
 });
 it("resumes a completed idempotent action from its receipt after pool restart without executing it twice",async()=>{
  const user=await owner(),task=await newTask(user,"Save tone");
  const model=vi.fn<AgentModel>()
   .mockResolvedValueOnce({text:"",calls:[{id:"save",name:"preferences_save",arguments:JSON.stringify({key:"tone",value:"concise"})}]})
   .mockResolvedValueOnce({text:"Saved.",calls:[]});
  await processClaim(await claim(),{model});
  expect((await taskFor(user,task.id)).status).toBe("waiting-for-user");
  const action=(await database().query("SELECT * FROM actions WHERE task_id=$1",[task.id])).rows[0];
  await approveAction(user,action.id,action.action_hash);
  const interrupted=await claim(),tool=tools.find(tool=>tool.name==="preferences_save")!;
  await executeAction({userId:user,taskId:task.id,signal:new AbortController().signal,idempotencyKey:"",leaseToken:interrupted.token,assertActive:()=>leaseActive(interrupted)},action.id,tool);
  await expired(task.id);await closeDatabase();
  const restarted=await claim();
  await processClaim(restarted,{model});
  const restored=await taskFor(user,task.id);
  expect(restored.status).toBe("succeeded");
  expect((await database().query("SELECT * FROM action_events WHERE action_id=$1 AND kind='action_started'",[action.id])).rowCount).toBe(1);
  expect(model).toHaveBeenCalledTimes(2);
 });
 it("does not reopen a completed task when its worker dies before releasing the lease",async()=>{
  const user=await owner(),task=await newTask(user,"Fixture"),first=await claim();
  await checkpoint(user,task.id,{v:1,step:1,calls:0,history:[],failures:0},"succeeded",{summary:"Done",receipts:[]},first.token);
  await expired(task.id);
  expect(await claimTask()).toBe(null);
  expect((await taskFor(user,task.id)).status).toBe("succeeded");
  expect((await database().query("SELECT state FROM task_queue WHERE task_id=$1",[task.id])).rows[0].state).toBe("succeeded");
 });
 it("bounds transient retries and reports terminal failure with receipts",async()=>{
  const user=await owner(),task=await newTask(user,"Fixture"),model=vi.fn<AgentModel>(async()=>{throw new ApiError(502,"provider_unavailable","Unavailable");});
  for(let i=0;i<3;i++){
   await processClaim(await claim(),{model});
   await database().query("UPDATE task_queue SET available_at=now() WHERE task_id=$1",[task.id]);
  }
  const result=await taskFor(user,task.id);
  expect(result.status).toBe("failed");expect(result.error_code).toBe("provider_unavailable");
  expect(result.result.partial).toBe(true);expect(model).toHaveBeenCalledTimes(3);
  expect(await claimTask()).toBe(null);
 });
 it("cancellation wins over a late model response",async()=>{
  const user=await owner(),task=await newTask(user,"Fixture"),claimed=await claim();
  await processClaim(claimed,{model:async()=>{await cancelTask(user,task.id);return{text:"Late success",calls:[]};}});
  expect((await taskFor(user,task.id)).status).toBe("cancelled");
  expect((await database().query("SELECT state FROM task_queue WHERE task_id=$1",[task.id])).rows[0].state).toBe("cancelled");
 });
 it("does not retry an unsupported provider configuration",async()=>{
  const user=await owner(),task=await newTask(user,"Fixture");
  vi.stubEnv("AI_PROVIDER","xai");
  await processClaim(await claim());
  const result=await taskFor(user,task.id);
  expect(result.status).toBe("failed");expect(result.error_code).toBe("unsupported_provider");
  expect(createResponse).not.toHaveBeenCalled();expect(await claimTask()).toBe(null);
 });
 it("requeues an interrupted worker and succeeds on the next bounded attempt",async()=>{
  const user=await owner(),task=await newTask(user,"Fixture"),controller=new AbortController();
  const interrupted=await claim();controller.abort();
  await processClaim(interrupted,{signal:controller.signal,model:vi.fn<AgentModel>()});
  expect((await taskFor(user,task.id)).status).toBe("pending");
  await database().query("UPDATE task_queue SET available_at=now() WHERE task_id=$1",[task.id]);
  await processClaim(await claim(),{model:async()=>({text:"Recovered",calls:[]})});
  expect((await taskFor(user,task.id)).status).toBe("succeeded");
 });
 it("does not lose approval that arrives before the worker publishes its waiting checkpoint",async()=>{
  const user=await owner(),task=await newTask(user,"Save tone"),claimed=await claim(),tool=tools.find(t=>t.name==="preferences_save")!;
  const context={userId:user,taskId:task.id,signal:new AbortController().signal,idempotencyKey:"",leaseToken:claimed.token,assertActive:()=>leaseActive(claimed)};
  const action=await prepareAction(context,"1:0",tool,{key:"tone",value:"concise"});
  expect((await executeAction(context,action.id,tool)).waiting).toBe(true);
  await approveAction(user,action.id,action.action_hash);
  await checkpoint(user,task.id,{v:1,step:1,calls:0,history:[],failures:0},"waiting-for-user",{waitingActionId:action.id},claimed.token);
  await finishClaim(claimed);
  expect((await taskFor(user,task.id)).status).toBe("pending");
  expect((await database().query("SELECT state FROM task_queue WHERE task_id=$1",[task.id])).rows[0].state).toBe("pending");
 });
 it("keeps a committed terminal result when a late worker timeout is reported",async()=>{
  const user=await owner(),task=await newTask(user,"Fixture"),claimed=await claim();
  await checkpoint(user,task.id,{v:1,step:1,calls:0,history:[],failures:0},"succeeded",{summary:"Done",receipts:[]},claimed.token);
  await finishClaim(claimed,new ApiError(504,"provider_timeout","Late timeout"));
  expect((await taskFor(user,task.id)).status).toBe("succeeded");
  expect((await database().query("SELECT state FROM task_queue WHERE task_id=$1",[task.id])).rows[0].state).toBe("succeeded");
  expect(await claimTask()).toBe(null);
 });
 it("retains the global spending hold when an account is deleted",async()=>{
  const row=(await database().query("SELECT spent::text,reserved::text FROM global_usage_windows WHERE bucket=(now() AT TIME ZONE 'UTC')::date")).rows[0]||{spent:"0",reserved:"0"};
  vi.stubEnv("JENSEN_GLOBAL_DAILY_MICRO_USD",String(Number(row.spent)+Number(row.reserved)+5));
  const a=await owner(),b=await owner(),lease=await reserveUsage(a,"fixture",5);
  await database().query("DELETE FROM users WHERE id=$1",[a]);
  expect((await database().query("SELECT user_id FROM provider_leases WHERE id=$1",[lease])).rows[0].user_id).toBe(null);
  await expect(reserveUsage(b,"fixture",1)).rejects.toMatchObject({code:"global_budget_exceeded"});
  await settleUsage(lease,0);await settleUsage(await reserveUsage(b,"fixture",1),0);
 });
});
