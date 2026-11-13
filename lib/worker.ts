import {ApiError} from "./api-errors";
import {modelFor,runAgent,type AgentModel} from "./agent";
import {tools} from "./tools";
import type {Tool} from "./tool-contracts";
import {claimTask,finishClaim,heartbeat,leaseActive,type Claim} from "./queue";
import {withDeadline} from "./request-resources";
export async function processClaim(claim:Claim,options:{model?:AgentModel;registry?:Tool[];signal?:AbortSignal}={}){
 const controller=new AbortController(),parent=options.signal;
 const cancel=()=>controller.abort();
 if(parent?.aborted)controller.abort();else parent?.addEventListener("abort",cancel,{once:true});
 let pending=false;
 const timer=setInterval(()=>{
  if(pending)return;pending=true;
  void heartbeat(claim).catch(()=>controller.abort()).finally(()=>{pending=false;});
 },5000);
 let failure:unknown;
 try{
  const guard=async()=>{if(controller.signal.aborted)throw new ApiError(499,"worker_cancelled","Worker stopped.");await leaseActive(claim);};
  await withDeadline(controller.signal,120000,signal=>runAgent(claim.userId,claim.taskId,options.registry||tools,options.model||modelFor(claim.userId),signal,
   async()=>{if(signal.aborted)throw signal.reason;await guard();},claim.token));
 }catch(error){failure=error;}
 finally{clearInterval(timer);parent?.removeEventListener("abort",cancel);}
 await finishClaim(claim,failure);
}
export async function workOnce(options:Parameters<typeof processClaim>[1]={}){
 const claim=await claimTask();if(!claim)return false;
 await processClaim(claim,options);return true;
}
