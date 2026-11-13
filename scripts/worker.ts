import {workOnce} from "../lib/worker";
import {closeDatabase} from "../lib/db";
try{process.loadEnvFile(".env.local");}catch{}
const controller=new AbortController();
process.once("SIGINT",()=>controller.abort());
process.once("SIGTERM",()=>controller.abort());
async function run(){
 console.log("Jensen worker started.");
 if(process.argv.includes("--once")){await workOnce({signal:controller.signal});return;}
 while(!controller.signal.aborted){
  try{if(await workOnce({signal:controller.signal}))continue;}
  catch{console.error("Worker operation failed; leased work will recover within its retry limit.");}
  await new Promise<void>(resolve=>{
   const timer=setTimeout(done,500);
   function done(){clearTimeout(timer);controller.signal.removeEventListener("abort",done);resolve();}
   controller.signal.addEventListener("abort",done,{once:true});if(controller.signal.aborted)done();
  });
 }
}
run().catch(()=>{console.error("Worker stopped unexpectedly.");process.exitCode=1;}).finally(closeDatabase);
