"use client";
import {useCallback,useEffect,useRef,useState} from "react";
type Task={id:string;status:string;result?:{summary?:string;receipts?:{id:string;tool:string;status:string}[]}};
type Action={id:string;task_id:string;preview:string;action_hash:string;status:string;effect:string;arguments:unknown;expires_at:string};
type Grant={id:string;tool:string;expires_at:string;revoked_at:string|null};
export default function TaskPanel({userId}:{userId:string}){
 const [prompt,setPrompt]=useState(""),[tasks,setTasks]=useState<Task[]>([]),[actions,setActions]=useState<Action[]>([]),[grants,setGrants]=useState<Grant[]>([]);
 const [error,setError]=useState(""),[busy,setBusy]=useState(false),[sessionValid,setSessionValid]=useState(false);
 const lifecycle=useRef({generation:0,controller:null as AbortController|null,inFlight:false});
 const refresh=useCallback(async()=>{
  const state=lifecycle.current;if(state.inFlight||document.hidden)return;
  const generation=state.generation,controller=new AbortController();state.controller=controller;state.inFlight=true;
  const timer=setTimeout(()=>controller.abort(),10000);
  try{
   const session=await fetch("/api/auth/session",{cache:"no-store",signal:controller.signal});
   const identity=await session.json();
   if(generation!==state.generation)return;
   if(identity.user?.id!==userId){setTasks([]);setActions([]);setGrants([]);setSessionValid(false);setError("Session changed. Reload to continue.");return;}
   const responses=await Promise.all(["tasks","actions","grants"].map(name=>fetch("/api/"+name,{cache:"no-store",headers:{"x-jensen-user":userId},signal:controller.signal})));
   const values=await Promise.all(responses.map(async response=>{
    const body=await response.json();if(!response.ok)throw new Error("Cannot load tasks.");return body;
   }));
   if(generation!==state.generation)return;
   setSessionValid(true);setTasks(values[0].tasks);setActions(values[1].actions);setGrants(values[2].grants);
  }catch{if(generation===state.generation)setError("Unable to refresh tasks. Reload or try again.");}
  finally{clearTimeout(timer);if(generation===state.generation)state.inFlight=false;}
 },[userId]);
 useEffect(()=>{
  const state=lifecycle.current;state.generation++;
  const initial=setTimeout(()=>void refresh(),0);const timer=setInterval(()=>void refresh(),2000);
  const visibility=()=>{
   state.generation++;state.controller?.abort();state.inFlight=false;
   setTasks([]);setActions([]);setGrants([]);setPrompt("");setBusy(false);setSessionValid(false);
   if(!document.hidden)void refresh();
  };
  document.addEventListener("visibilitychange",visibility);
  return()=>{state.generation++;state.controller?.abort();state.inFlight=false;clearInterval(timer);clearTimeout(initial);document.removeEventListener("visibilitychange",visibility);};
 },[refresh]);
 async function mutate(path:string,method:string,body?:unknown){
  const generation=lifecycle.current.generation;setBusy(true);setError("");
  try{
   const response=await fetch(path,{method,headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID(),"x-jensen-user":userId},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(125000)});
   const data=await response.json();
   if(generation!==lifecycle.current.generation)return;
   if(!response.ok)throw new Error(data.error||"Task action failed.");
   if(path==="/api/tasks")setPrompt("");
   await refresh();
  }catch(reason){if(generation===lifecycle.current.generation)setError(reason instanceof Error?reason.message:"Task request failed.");}
  finally{if(generation===lifecycle.current.generation)setBusy(false);}
 }
 const blocked=busy||!sessionValid;
 return<section aria-label="Tasks and approvals">
  <h2>Tasks and approvals</h2>
  <p>Tasks can read saved preferences, save approved changes, and read approved public web pages.</p>
  <label>Task request<textarea value={prompt} maxLength={8192} onChange={event=>setPrompt(event.target.value)}/></label>
  <button type="button" disabled={blocked||!prompt.trim()} onClick={()=>void mutate("/api/tasks","POST",{prompt:prompt.trim()})}>Run task</button>
  {error?<p role="alert">{error}</p>:null}
  {tasks.map(task=><article key={task.id}>
   <p>Task {task.id.slice(0,8)}: {task.status}</p>
   {task.result?.receipts?.map(receipt=><p key={receipt.id}>{receipt.tool}: {receipt.status}</p>)}
   {task.result?.summary?<p>Assistant summary: {task.result.summary}</p>:null}
   {task.status==="waiting-for-user"?<button disabled={blocked} onClick={()=>void mutate("/api/tasks/"+task.id+"/resume","POST",{})}>Resume task</button>:null}
   {!["succeeded","failed","cancelled"].includes(task.status)?<button disabled={blocked} onClick={()=>void mutate("/api/tasks/"+task.id,"DELETE")}>Cancel task</button>:null}
  </article>)}
  {actions.map(action=><article key={action.id}>
   <p>{action.preview} — {action.status}</p>
   <pre>{JSON.stringify(action.arguments,null,2)}</pre>
   <p>Approval expires {new Date(action.expires_at).toLocaleString()}.</p>
   {action.status==="pending"?<>
    <button disabled={blocked} onClick={()=>void mutate("/api/actions/"+action.id,"POST",{decision:"approve",hash:action.action_hash})}>Approve once</button>
    {!["external-message","paid-cancellation","purchase","commitment"].includes(action.effect)?<button disabled={blocked} onClick={()=>void mutate("/api/actions/"+action.id,"POST",{decision:"grant",hash:action.action_hash,seconds:3600})}>Allow this exact action for one hour</button>:null}
   </>:null}
   {["pending","revoked"].includes(action.status)?<button disabled={blocked} onClick={()=>void mutate("/api/actions/"+action.id,"POST",{decision:"renew"})}>Renew preview</button>:null}
   {["pending","approved"].includes(action.status)?<button disabled={blocked} onClick={()=>void mutate("/api/actions/"+action.id,"DELETE")}>Revoke approval</button>:null}
   {action.status==="uncertain"?<p>Outcome is uncertain. Verify with the service before starting another task; it will not be repeated automatically.</p>:null}
  </article>)}
  {grants.filter(grant=>!grant.revoked_at).map(grant=><p key={grant.id}>{grant.tool}: exact-action permission until {new Date(grant.expires_at).toLocaleString()} <button disabled={blocked} onClick={()=>void mutate("/api/grants/"+grant.id,"DELETE")}>Revoke permission</button></p>)}
 </section>;
}
