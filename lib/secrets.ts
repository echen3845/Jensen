import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from "node:crypto";
import {ApiError} from "./api-errors";
import {transaction} from "./db";
function keyRing(){
 let keys:Record<string,string>;
 try{keys=JSON.parse(process.env.JENSEN_CREDENTIAL_KEYS||"{}");}catch{throw new ApiError(503,"vault_configuration","Configure credential encryption keys.");}
 const active=process.env.JENSEN_ACTIVE_CREDENTIAL_KEY||"v1";
 const read=(id:string)=>{
  const key=Buffer.from(typeof keys[id]==="string"?keys[id]:"","base64");
  if(key.length!==32)throw new ApiError(503,"vault_configuration","Credential key is missing or invalid.");
  return key;
 };
 return{active,read};
}
const aad=(user:string,account:string,provider:string)=>Buffer.from("jensen-v1\0"+user+"\0"+account+"\0"+provider);
export function sealCredential(user:string,account:string,provider:string,secret:string){
 if(Buffer.byteLength(secret)>16384)throw new ApiError(413,"credential_too_large","Credential exceeds vault limit.");
 const ring=keyRing(),iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",ring.read(ring.active),iv);
 cipher.setAAD(aad(user,account,provider));
 const data=Buffer.concat([cipher.update(secret,"utf8"),cipher.final()]);
 return Buffer.from(JSON.stringify({v:1,kid:ring.active,iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64"),data:data.toString("base64")}));
}
export function openCredential(user:string,account:string,provider:string,encrypted:Buffer){
 try{
  const value=JSON.parse(encrypted.toString("utf8"));
  if(value.v!==1)throw new Error("version");
  const decipher=createDecipheriv("aes-256-gcm",keyRing().read(value.kid),Buffer.from(value.iv,"base64"));
  decipher.setAAD(aad(user,account,provider));decipher.setAuthTag(Buffer.from(value.tag,"base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.data,"base64")),decipher.final()]).toString("utf8");
 }catch{throw new ApiError(503,"credential_unavailable","Credential cannot be opened with the configured keys.");}
}
export async function saveCredential(user:string,provider:string,label:string,secret:string){
 const id=randomUUID(),encrypted=sealCredential(user,id,provider,secret);
 await transaction(async c=>{await c.query("INSERT INTO connected_accounts(id,user_id,provider,label,credential) VALUES($1,$2,$3,$4,$5)",[id,user,provider,label,encrypted]);},user);
 return id;
}
export async function rotateCredentials(user:string){
 return transaction(async c=>{
  const rows=(await c.query("SELECT id,provider,credential FROM connected_accounts WHERE user_id=$1 FOR UPDATE",[user])).rows;
  for(const row of rows)if(row.credential){
   const value=openCredential(user,row.id,row.provider,row.credential);
   await c.query("UPDATE connected_accounts SET credential=$3 WHERE id=$1 AND user_id=$2",[row.id,user,sealCredential(user,row.id,row.provider,value)]);
  }
 },user);
}
export async function disconnectAccount(user:string,id:string){
 return transaction(async c=>{
  const row=await c.query("DELETE FROM connected_accounts WHERE id=$1 AND user_id=$2 RETURNING id",[id,user]);
  if(!row.rowCount)throw new ApiError(404,"not_found","Connected account not found.");
 },user);
}
const sensitive=/token|secret|password|credential|authorization|api.?key/i;
export function containsSecret(value:string){
 const configured=["OPENAI_API_KEY","XAI_API_KEY","OIDC_CLIENT_SECRET","AUTH_SECRET"].map(name=>process.env[name]).filter((s):s is string=>!!s&&s.length>=8);
 return configured.some(secret=>value.includes(secret))||/\bsk-[a-z0-9_-]{12,}|\bBearer\s+[a-z0-9._-]{12,}/i.test(value);
}
export function redactText(value:string){
 let clean=value;
 for(const name of ["OPENAI_API_KEY","XAI_API_KEY","OIDC_CLIENT_SECRET","AUTH_SECRET"]){
  const secret=process.env[name];if(secret&&secret.length>=8)clean=clean.split(secret).join("[secret]");
 }
 return clean.replace(/\bsk-[a-z0-9_-]{12,}|\bBearer\s+[a-z0-9._-]{12,}/gi,"[secret]");
}
export function safeData(value:unknown):unknown{
 try{
  const text=JSON.stringify(value,(key,item)=>{
   if(sensitive.test(key))return"[redacted]";
   if(typeof item!=="string")return item;
   let clean=item;
   for(const name of ["OPENAI_API_KEY","XAI_API_KEY","OIDC_CLIENT_SECRET","AUTH_SECRET"]){
    const secret=process.env[name];if(secret&&secret.length>=8)clean=clean.split(secret).join("[redacted]");
   }
   return clean.replace(/\bsk-[a-z0-9_-]{12,}|\bBearer\s+[a-z0-9._-]{12,}/gi,"[redacted]").slice(0,4096);
  });
  if(!text)return null;
  return Buffer.byteLength(text)>8192?{truncated:true,excerpt:text.slice(0,2048)}:JSON.parse(text);
 }catch{return{error:"unserializable_result"};}
}
