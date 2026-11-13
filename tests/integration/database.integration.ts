import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
vi.unmock("../../lib/auth");vi.unmock("../../lib/store");
import {randomBytes,randomUUID} from "node:crypto";
import {database,migrate,closeDatabase,transaction} from "../../lib/db";
import {createConversation,messagePage,beginTurn,finishTurn,savePreference,serverContext,exportAccount,deleteAccount} from "../../lib/store";
import {currentIdentity,requireIdentity,hashToken,signOut} from "../../lib/auth";
import {getResourceLimits} from "../../lib/resource-limits";

const users:string[]=[];
beforeAll(async()=>{
 const url=process.env.TEST_DATABASE_URL;
 if(!url||!new URL(url).pathname.endsWith("_test"))throw new Error("Set TEST_DATABASE_URL to an isolated *_test database.");
 process.env.DATABASE_URL=url;
 await migrate();
});
afterAll(async()=>{
 for(const id of users)await database().query("DELETE FROM users WHERE id=$1",[id]);
 await closeDatabase();
});
async function user(){
 const id=randomUUID();users.push(id);
 await database().query("INSERT INTO users(id,issuer,subject) VALUES($1,'test',$2)",[id,id]);return id;
}
describe("PostgreSQL ownership and persistence",()=>{
 it("restores messages from another connection and rejects cross-owner access",async()=>{
  const a=await user(),b=await user(),conv=await createConversation(a);
  const message=randomUUID();
  const turn=await beginTurn(a,conv.id,message,"My durable prompt");
  await finishTurn(a,conv.id,message,"Stored response");
  expect(turn.seq).toBeDefined();
  expect((await messagePage(a,conv.id)).messages.map(m=>m.content)).toEqual(["My durable prompt","Stored response"]);
  await expect(messagePage(b,conv.id)).rejects.toMatchObject({status:404});
  await expect(beginTurn(b,conv.id,randomUUID(),"Forged")).rejects.toMatchObject({status:404});
  expect((await beginTurn(a,conv.id,message,"My durable prompt")).cached).toBe("Stored response");
  await expect(beginTurn(a,conv.id,message,"Changed")).rejects.toMatchObject({status:409});
 });
 it("paginates bounded history and retains saved constraints with provenance in server context",async()=>{
  const a=await user(),conv=await createConversation(a);
  let seq="";
  for(let i=0;i<45;i++){seq=(await beginTurn(a,conv.id,randomUUID(),"Message "+i)).seq!;}
  await savePreference(a,"housing_budget","Under 2000");
  const page=await messagePage(a,conv.id);
  expect(page.messages).toHaveLength(40);expect(page.hasMore).toBe(true);
  expect((await messagePage(a,conv.id,page.cursor)).messages).toHaveLength(5);
  const context=await serverContext(a,conv.id,seq,"System prompt",getResourceLimits());
  expect(context.some(m=>m.content.includes("explicit-user")&&m.content.includes("Under 2000"))).toBe(true);
  expect(context.at(-1)?.content).toBe("Message 44");
 });
 it("enforces RLS even when an application query omits its owner predicate",async()=>{
  const a=await user(),b=await user(),conv=await createConversation(a);
  // Test role has no superuser/BYPASSRLS; production must use the same restriction.
  await database().query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='jensen_rls_test') THEN CREATE ROLE jensen_rls_test; END IF; END $$");
  await database().query("GRANT USAGE ON SCHEMA public TO jensen_rls_test");
  await database().query("GRANT SELECT,INSERT ON conversations TO jensen_rls_test");
  await transaction(async c=>{
   await c.query("SET LOCAL ROLE jensen_rls_test");
   expect((await c.query("SELECT id FROM conversations WHERE id=$1",[conv.id])).rows).toHaveLength(0);
   await expect(c.query("INSERT INTO conversations(user_id) VALUES($1)",[a])).rejects.toBeDefined();
  },b).catch(error=>{if(error.code!=="25P02")throw error;});
 });
 it("stores only session hashes and invalidates a signed-out session",async()=>{
  const id=await user(),token=randomBytes(32).toString("hex");
  await database().query("INSERT INTO sessions VALUES($1,$2,now()+interval '1 hour')",[hashToken(token),id]);
  const request=new Request("http://localhost:3000/api/auth/signout",{method:"POST",headers:{cookie:"jensen.session="+token,origin:"http://localhost:3000"}});
  expect((await currentIdentity(request))?.id).toBe(id);
  await expect(requireIdentity(new Request(request,{headers:{cookie:"jensen.session="+token,origin:"https://evil.test"}}))).rejects.toMatchObject({status:403});
  const response=await signOut(request);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(await currentIdentity(request)).toBe(null);
  expect(await currentIdentity(new Request("http://localhost",{headers:{cookie:"jensen.session="+randomBytes(32).toString("hex")}}))).toBe(null);
 });
 it("exports only owned data without credentials and deletes all owner records",async()=>{
  const a=await user(),conv=await createConversation(a);
  await beginTurn(a,conv.id,randomUUID(),"Export me");
  const data=await exportAccount(a);
  expect(data.messages).toHaveLength(1);
  expect(JSON.stringify(data)).not.toContain("token_hash");
  await deleteAccount(a);
  expect((await database().query("SELECT id FROM conversations WHERE user_id=$1",[a])).rowCount).toBe(0);
 });
});
