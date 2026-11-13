import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
vi.unmock("../../lib/quotas");
import {randomUUID} from "node:crypto";
import {database,migrate,closeDatabase} from "../../lib/db";
import {reserveUsage,settleUsage,withUsage,throttleAnonymous} from "../../lib/quotas";
const owners:string[]=[];
beforeAll(async()=>{
 const url=process.env.TEST_DATABASE_URL;
 if(!url||!new URL(url).pathname.endsWith("_test"))throw new Error("Use an isolated test database.");
 process.env.DATABASE_URL=url;await migrate();
});
afterAll(async()=>{for(const id of owners)await database().query("DELETE FROM users WHERE id=$1",[id]);await closeDatabase();});
async function user(){const id=randomUUID();owners.push(id);await database().query("INSERT INTO users(id,issuer,subject) VALUES($1,'quota-test',$2)",[id,id]);return id;}
describe("shared PostgreSQL admission control",()=>{
 it("serializes concurrent reservations and reconciles a hold once",async()=>{
  const id=await user();vi.stubEnv("JENSEN_DAILY_MICRO_USD","100");vi.stubEnv("JENSEN_USER_CONCURRENCY","10");
  const results=await Promise.allSettled([reserveUsage(id,"chat",60),reserveUsage(id,"chat",60)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  const lease=(results.find(r=>r.status==="fulfilled") as PromiseFulfilledResult<string>).value;
  await settleUsage(lease,20);await settleUsage(lease,20);
  const row=(await database().query("SELECT spent::text,reserved::text FROM usage_windows WHERE user_id=$1",[id])).rows[0];
  expect(row).toEqual({spent:"20",reserved:"0"});
 });
 it("rejects over-concurrency requests before running provider work",async()=>{
  const id=await user();vi.stubEnv("JENSEN_USER_CONCURRENCY","1");
  const lease=await reserveUsage(id,"chat",1);
  const work=vi.fn(async()=>({}));
  await expect(withUsage(id,"chat",1,work)).rejects.toMatchObject({code:"concurrency_limited"});
  expect(work).not.toHaveBeenCalled();await settleUsage(lease,0);
 });
 it("charges unknown failed calls conservatively and releases concurrency",async()=>{
  const id=await user();
  await expect(withUsage(id,"chat",50,async()=>{throw new Error("provider uncertain");})).rejects.toThrow();
  const row=(await database().query("SELECT spent::text,reserved::text FROM usage_windows WHERE user_id=$1",[id])).rows[0];
  expect(row).toEqual({spent:"50",reserved:"0"});
 });
 it("recovers crashed leases without forgiving their reserved cost",async()=>{
  const id=await user(),lease=await reserveUsage(id,"chat",50);
  await database().query("UPDATE provider_leases SET expires_at=now()-interval '1 second' WHERE id=$1",[lease]);
  const next=await reserveUsage(id,"chat",10);
  const row=(await database().query("SELECT spent::text,reserved::text FROM usage_windows WHERE user_id=$1",[id])).rows[0];
  expect(row).toEqual({spent:"50",reserved:"10"});await settleUsage(next,0);
 });
 it("limits shared anonymous traffic without trusting spoofed forwarding headers",async()=>{
  vi.stubEnv("JENSEN_ANONYMOUS_PER_MINUTE","1");
  await database().query("DELETE FROM rate_limits WHERE scope='anonymous'");
  await throttleAnonymous(new Request("http://localhost",{headers:{"x-forwarded-for":"1.1.1.1"}}));
  await expect(throttleAnonymous(new Request("http://localhost",{headers:{"x-forwarded-for":"8.8.8.8"}}))).rejects.toMatchObject({status:429});
  await database().query("DELETE FROM rate_limits WHERE scope='anonymous'");
 });
 it("shares the global concurrency cap across different owners",async()=>{
  const a=await user(),b=await user();vi.stubEnv("JENSEN_GLOBAL_CONCURRENCY","1");
  const first=await reserveUsage(a,"chat",1);
  await expect(reserveUsage(b,"chat",1)).rejects.toMatchObject({code:"concurrency_limited"});
  await settleUsage(first,0);
  await settleUsage(await reserveUsage(b,"chat",1),0);
 });
});
