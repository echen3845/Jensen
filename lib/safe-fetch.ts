import {lookup} from "node:dns/promises";
import {isIP} from "node:net";
import {request} from "node:https";
import ipaddr from "ipaddr.js";
import {ApiError} from "./api-errors";
export function publicAddress(value:string){
 try{return ipaddr.process(value).range()==="unicast";}catch{return false;}
}
export async function inspectTarget(value:string,resolve=lookup){
 let url:URL;
 try{url=new URL(value);}catch{throw new ApiError(400,"invalid_url","Invalid web address.");}
 const host=url.hostname.replace(/^\[|\]$/g,"");
 if(url.protocol!=="https:"||url.username||url.password||url.hash||(url.port&&url.port!=="443")||
  !host.includes(".")&&!isIP(host)||/(^|\.)(localhost|local|internal|home|lan)$/.test(host)){
  throw new ApiError(403,"network_target_blocked","Only public HTTPS addresses are allowed.");
 }
 for(const key of url.searchParams.keys())if(/token|secret|password|credential|authorization|api.?key|signature/i.test(key))throw new ApiError(403,"sensitive_url","Credentials cannot be sent in web tool URLs.");
 const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await resolve(host,{all:true,verbatim:true});
 if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw new ApiError(403,"network_target_blocked","Private, local, and reserved destinations are blocked.");
 return{url,addresses};
}
export async function safeFetch(value:string,signal:AbortSignal){
 const {url,addresses}=await inspectTarget(value);
 if(signal.aborted)throw signal.reason;
 return new Promise<string>((resolve,reject)=>{
  const req=request(url,{
   method:"GET",signal,agent:false,
   lookup:(_host,options,done)=>{
    if(options.all)done(null,addresses);
    else done(null,addresses[0].address,addresses[0].family);
   },
   headers:{"user-agent":"Jensen/1","accept":"text/plain,text/html,application/json"}
  },async response=>{
   try{
    if(response.statusCode&&response.statusCode>=300&&response.statusCode<400)throw new ApiError(403,"redirect_blocked","Redirects require a separately approved public URL.");
    if(!response.statusCode||response.statusCode>=400)throw new ApiError(502,"web_request_failed","The public website could not complete this request.");
    const type=String(response.headers["content-type"]||"");
    if(!/^(text\/|application\/json)/i.test(type))throw new ApiError(415,"web_content_unsupported","Only text and JSON responses are supported.");
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of response){
     const data=Buffer.from(chunk);size+=data.length;
     if(size>65536)throw new ApiError(413,"web_result_too_large","Website response exceeds the byte limit.");
     chunks.push(data);
    }
    resolve(Buffer.concat(chunks).toString("utf8"));
   }catch(error){response.destroy();reject(error);}
  });
  req.on("error",()=>reject(signal.aborted?signal.reason:new ApiError(502,"web_request_failed","The public website could not complete this request.")));
  req.end();
 });
}
