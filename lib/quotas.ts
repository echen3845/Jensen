import {createHmac,randomUUID} from "node:crypto";
import {isIP} from "node:net";
import type {PoolClient} from "pg";
import {ApiError} from "./api-errors";
import {transaction} from "./db";
import {getResourceLimits} from "./resource-limits";

function number(name:string,fallback:number,max:number){
 const value=Number(process.env[name]);
 return Number.isSafeInteger(value)&&value>0&&value<=max?value:fallback;
}
export function quotaPolicy(){return{
 daily:number("JENSEN_DAILY_MICRO_USD",1_000_000,1_000_000_000),
 userConcurrency:number("JENSEN_USER_CONCURRENCY",2,20),
 globalConcurrency:number("JENSEN_GLOBAL_CONCURRENCY",8,200),
 requestsPerMinute:number("JENSEN_REQUESTS_PER_MINUTE",30,600),
 anonymousPerMinute:number("JENSEN_ANONYMOUS_PER_MINUTE",120,6000),
 ipPerMinute:number("JENSEN_IP_PER_MINUTE",10,600)
};}
export function prices(operation:"chat"|"transcribe"){
 const names=operation==="chat"?["JENSEN_CHAT_INPUT_MICRO_USD","JENSEN_CHAT_OUTPUT_MICRO_USD"]:["JENSEN_AUDIO_MICRO_USD_PER_SECOND"];
 const values=names.map(name=>Number(process.env[name]));
 if(values.some(value=>!Number.isSafeInteger(value)||value<1||value>100000))throw new ApiError(503,"pricing_configuration","Configure provider price ceilings before live requests.");
 return values;
}
export function chatReservation(messages:{content:string}[],outputTokens:number){
 const [input,output]=prices("chat");
 return messages.reduce((sum,m)=>sum+Buffer.byteLength(m.content)+128,0)*input+outputTokens*output;
}
export function actualChatCost(response:unknown){
 const value=response as {usage?:{input_tokens?:number;output_tokens?:number}};
 const i=value.usage?.input_tokens,o=value.usage?.output_tokens;
 if(!Number.isSafeInteger(i)||!Number.isSafeInteger(o)||i!<0||o!<0)return undefined;
 const [input,output]=prices("chat");const cost=i!*input+o!*output;
 return Number.isSafeInteger(cost)?cost:undefined;
}
async function rate(client:PoolClient,scope:string,limit:number){
 const result=await client.query("INSERT INTO rate_limits(scope,bucket,used) VALUES($1,floor(extract(epoch FROM now())/60)::bigint,1) ON CONFLICT(scope,bucket) DO UPDATE SET used=rate_limits.used+1 RETURNING used",[scope]);
 if(result.rows[0].used>limit)throw new ApiError(429,"rate_limited","Too many requests. Try again shortly.",60);
}
export async function throttleAnonymous(request:Request){
 const policy=quotaPolicy();
 await transaction(async client=>{
  await rate(client,"anonymous",policy.anonymousPerMinute);
  const header=process.env.JENSEN_TRUSTED_IP_HEADER;
  const ip=header?request.headers.get(header):null;
  if(ip&&isIP(ip)){
   if(!process.env.AUTH_SECRET)throw new ApiError(503,"auth_configuration","Configure AUTH_SECRET.");
   const digest=createHmac("sha256",process.env.AUTH_SECRET).update(ip).digest("hex");
   await rate(client,"ip:"+digest,policy.ipPerMinute);
  }
 });
}
async function lock(client:PoolClient){await client.query("SELECT pg_advisory_xact_lock(8102510)");}
async function chargeExpired(client:PoolClient){
 const expired=await client.query("UPDATE provider_leases SET state='charged',final_cost=reservation WHERE state='pending' AND expires_at<=now() RETURNING user_id,bucket,reservation");
 for(const row of expired.rows)await client.query("UPDATE usage_windows SET reserved=reserved-$3::bigint,spent=spent+$3::bigint WHERE user_id=$1 AND bucket=$2",[row.user_id,row.bucket,row.reservation]);
}
export async function reserveUsage(user:string,operation:string,amount:number){
 if(!Number.isSafeInteger(amount)||amount<0)throw new ApiError(503,"invalid_reservation","Unable to calculate resource reservation.");
 const policy=quotaPolicy(),id=randomUUID();
 return transaction(async client=>{
  await lock(client);await chargeExpired(client);
  await rate(client,"user:"+user,policy.requestsPerMinute);
  const active=await client.query("SELECT count(*)::int AS total,count(*) FILTER (WHERE user_id=$1)::int AS owned FROM provider_leases WHERE state='pending'",[user]);
  if(active.rows[0].total>=policy.globalConcurrency||active.rows[0].owned>=policy.userConcurrency)throw new ApiError(429,"concurrency_limited","Other requests are still running. Try again shortly.",5);
  await client.query("INSERT INTO usage_windows(user_id,bucket) VALUES($1,(now() AT TIME ZONE 'UTC')::date) ON CONFLICT DO NOTHING",[user]);
  const reserved=await client.query("UPDATE usage_windows SET reserved=reserved+$2::bigint,requests=requests+1 WHERE user_id=$1 AND bucket=(now() AT TIME ZONE 'UTC')::date AND spent+reserved+$2::bigint<=$3::bigint RETURNING bucket",[user,amount,policy.daily]);
  if(!reserved.rowCount)throw new ApiError(429,"budget_exceeded","Daily configured usage budget reached.",60);
  await client.query("INSERT INTO provider_leases(id,user_id,bucket,operation,reservation,expires_at,state) VALUES($1,$2,$3,$4,$5,now()+($6::int*interval '1 millisecond'),'pending')",
   [id,user,reserved.rows[0].bucket,operation,amount,getResourceLimits().providerTimeoutMs+60000]);
  return id;
 });
}
export async function settleUsage(id:string,actual?:number){
 return transaction(async client=>{
  await lock(client);
  const row=(await client.query("UPDATE provider_leases SET state=$2,final_cost=COALESCE($3::bigint,reservation) WHERE id=$1 AND state='pending' RETURNING user_id,bucket,reservation,final_cost",[id,actual===undefined?"charged":"settled",actual??null])).rows[0];
  if(row)await client.query("UPDATE usage_windows SET reserved=reserved-$3::bigint,spent=spent+$4::bigint WHERE user_id=$1 AND bucket=$2",[row.user_id,row.bucket,row.reservation,row.final_cost]);
 });
}
export async function withUsage<T>(user:string,operation:string,amount:number,work:()=>Promise<T>,actual?:(result:T)=>number|undefined):Promise<T>{
 const lease=await reserveUsage(user,operation,amount);
 try{
  const result=await work();
  await settleUsage(lease,actual?.(result));
  return result;
 }catch(error){
  // A failed/aborted call may already have incurred provider cost. Charge its hold.
  await settleUsage(lease);
  throw error;
 }
}
