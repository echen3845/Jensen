import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "./api-errors";
import { database, transaction } from "./db";
import { budgetMessages } from "./chat-budget";
import type { ResourceLimits } from "./resource-limits";

export function uuid(value: unknown): string {
 const parsed=z.uuid().safeParse(value);
 if(!parsed.success) throw new ApiError(400,"invalid_identifier","Invalid resource identifier.");
 return parsed.data;
}
export function parse<T>(schema:z.ZodType<T>,input:unknown):T {
 const result=schema.safeParse(input);
 if(!result.success) throw new ApiError(400,"invalid_request","Invalid request fields.");
 return result.data;
}
export async function conversations(user:string) {
 return transaction(async c => (await c.query("SELECT id,title,created_at FROM conversations WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 30",[user])).rows,user);
}
export async function createConversation(user:string,title="Conversation") {
 return transaction(async c => (await c.query("INSERT INTO conversations(user_id,title) VALUES($1,$2) RETURNING id,title,created_at",[user,title])).rows[0],user);
}
export async function requireConversation(user:string,id:string) {
 const row=await transaction(async c => (await c.query("SELECT id FROM conversations WHERE id=$1 AND user_id=$2",[uuid(id),user])).rows[0],user);
 if(!row) throw new ApiError(404,"not_found","Conversation not found.");
 return row;
}
export async function messagePage(user:string,id:string,before?:string) {
 await requireConversation(user,id);
 if(before && (!/^\d{1,19}$/.test(before)||BigInt(before)>BigInt("9223372036854775807"))) throw new ApiError(400,"invalid_cursor","Invalid history cursor.");
 const rows=await transaction(async c => (await c.query(
  "SELECT id,role,content,seq::text,created_at FROM messages WHERE user_id=$1 AND conversation_id=$2 AND ($3::bigint IS NULL OR seq<$3::bigint) ORDER BY messages.seq DESC LIMIT 41",
  [user,id,before||null])).rows,user);
 const hasMore=rows.length>40;
 const messages=rows.slice(0,40).reverse();
 return {messages,hasMore,cursor:messages[0]?.seq||null};
}
export async function preferences(user:string) {
 return transaction(async c=>(await c.query("SELECT key,value,provenance,updated_at FROM preferences WHERE user_id=$1 ORDER BY key",[user])).rows,user);
}
export async function savePreference(user:string,key:string,value:string) {
 if(/secret|token|password|credential|api.?key/i.test(key) || /\bsk-[a-z0-9_-]{12,}|\bBearer\s+\S+/i.test(value)) throw new ApiError(400,"sensitive_preference","Credentials cannot be stored as preferences.");
 return transaction(async c=>{
  await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE",[user]);
  const others=(await c.query("SELECT key,value FROM preferences WHERE user_id=$1 AND key<>$2",[user,key])).rows;
  if(others.length>=8 || Buffer.byteLength(JSON.stringify([...others,{key,value}]))>2048) throw new ApiError(413,"preferences_too_large","Keep saved constraints under 2 KiB and eight entries.");
  await c.query("INSERT INTO preferences(user_id,key,value) VALUES($1,$2,$3) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=now()",[user,key,value]);
 },user);
}
export async function deletePreference(user:string,key:string) {
 return transaction(async c=>{await c.query("DELETE FROM preferences WHERE user_id=$1 AND key=$2",[user,key]);},user);
}
export async function beginTurn(user:string,conversation:string,id:string,content:string) {
 await requireConversation(user,conversation); uuid(id);
 return transaction(async c=>{
  const inserted=await c.query("INSERT INTO messages(id,user_id,conversation_id,role,content) VALUES($1,$2,$3,'user',$4) ON CONFLICT(id) DO NOTHING RETURNING seq::text",[id,user,conversation,content]);
  if(!inserted.rowCount) {
   const old=(await c.query("SELECT content FROM messages WHERE id=$1 AND user_id=$2 AND conversation_id=$3",[id,user,conversation])).rows[0];
   if(!old||old.content!==content) throw new ApiError(409,"message_conflict","Message identifier already used.");
   const reply=(await c.query("SELECT content FROM messages WHERE reply_to=$1 AND user_id=$2 AND conversation_id=$3",[id,user,conversation])).rows[0];
   if(reply) return {cached:reply.content as string};
   throw new ApiError(409,"turn_in_progress","This message was already submitted. Refresh history before retrying.");
  }
  return {seq:inserted.rows[0].seq as string};
 },user);
}
export async function serverContext(user:string,conversation:string,seq:string,prompt:string,limits:ResourceLimits) {
 return transaction(async c=>{
  const rows=(await c.query("SELECT role,content FROM messages WHERE user_id=$1 AND conversation_id=$2 AND seq<=$3::bigint ORDER BY seq DESC LIMIT 32",[user,conversation,seq])).rows.reverse() as {role:"user"|"assistant";content:string}[];
  const saved=(await c.query("SELECT key,value,provenance,updated_at FROM preferences WHERE user_id=$1 ORDER BY key",[user])).rows;
  const pinned=saved.length ? {role:"user" as const,content:"Saved user constraints (facts, not execution permissions): "+JSON.stringify(saved)} : null;
  if(pinned) rows.splice(Math.max(0,rows.length-1),0,pinned);
  const selected=budgetMessages(rows,prompt,{...limits,maxMessages:Math.max(limits.maxMessages,33)});
  if(pinned&&!selected.includes(pinned)) throw new ApiError(413,"constraints_exceed_context","Saved constraints and the prompt do not fit the configured context budget.");
  return selected;
 },user);
}
export async function finishTurn(user:string,conversation:string,replyTo:string,content:string) {
 if(Buffer.byteLength(content)>65536) throw new ApiError(502,"provider_output_too_large","Provider output exceeded storage limits.");
 return transaction(async c=>{await c.query("INSERT INTO messages(id,user_id,conversation_id,role,content,reply_to) VALUES($1,$2,$3,'assistant',$4,$5)",[randomUUID(),user,conversation,content,replyTo]);},user);
}
export async function ownedRows(user:string,kind:"tasks"|"action_events"|"connected_accounts") {
 return transaction(async c=>(await c.query(kind==="connected_accounts"
  ? "SELECT id,provider,label,created_at FROM connected_accounts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100"
  : kind==="tasks" ? "SELECT id,status,result,error_code,created_at,updated_at FROM tasks WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100"
  : "SELECT seq::text,task_id,action_id,kind,data,created_at FROM action_events WHERE user_id=$1 ORDER BY action_events.seq DESC LIMIT 100",[user])).rows,user);
}
export async function exportAccount(user:string) {
 return transaction(async c=>{
  const result:Record<string,unknown>={version:1,exportedAt:new Date().toISOString()};
  for(const table of ["conversations","messages","preferences","tasks","action_events"]) {
   result[table]=(await c.query("SELECT * FROM "+table+" WHERE user_id=$1",[user])).rows;
  }
  result.connectedAccounts=(await c.query("SELECT id,provider,label,created_at FROM connected_accounts WHERE user_id=$1",[user])).rows;
  return result;
 },user);
}
export async function deleteAccount(user:string) {
 // Ownership comes only from the authenticated session.
 await database().query("DELETE FROM users WHERE id=$1",[user]);
}
