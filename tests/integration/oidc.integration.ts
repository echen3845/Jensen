import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
vi.unmock("../../lib/auth");vi.unmock("../../lib/store");
vi.mock("openid-client",async importOriginal=>{
 const actual=await importOriginal<typeof import("openid-client")>();
 return {...actual,
  discovery:vi.fn(async()=>new actual.Configuration({
   issuer:"https://issuer.test",authorization_endpoint:"https://issuer.test/auth",token_endpoint:"https://issuer.test/token",jwks_uri:"https://issuer.test/keys"
  },"test-client",{client_secret:"test-secret"})),
  authorizationCodeGrant:vi.fn(async()=>({claims:()=>({iss:"https://issuer.test",sub:"oidc-test",email:"owner@example.test",email_verified:true})}))
 };
});
import * as oidc from "openid-client";
import {POST as chat} from "../../app/api/chat/route";
import {POST as transcribe} from "../../app/api/transcribe/route";
import {createResponse,createTranscription} from "../mocks/openai";
import {database,migrate,closeDatabase} from "../../lib/db";
import {beginLogin,finishLogin,currentIdentity,hashToken} from "../../lib/auth";
import {GET as login} from "../../app/api/auth/login/route";
beforeAll(async()=>{
 const url=process.env.TEST_DATABASE_URL;
 if(!url||!new URL(url).pathname.endsWith("_test"))throw new Error("Use an isolated test database.");
 process.env.DATABASE_URL=url;await migrate();
});
afterAll(async()=>{
 await database().query("DELETE FROM users WHERE issuer='https://issuer.test' AND subject='oidc-test'");
 await closeDatabase();
});
async function flow(){
 vi.stubEnv("APP_URL","http://localhost:3000");vi.stubEnv("AUTH_SECRET",Buffer.alloc(32,7).toString("base64"));
 vi.stubEnv("OIDC_ISSUER","https://issuer.test");vi.stubEnv("OIDC_CLIENT_ID","test-client");vi.stubEnv("OIDC_CLIENT_SECRET","test-secret");
 const response=await beginLogin();
 const location=new URL(response.headers.get("location")!);
 return {location,cookie:response.headers.get("set-cookie")!.split(";")[0]};
}
describe("OIDC flow and session restoration",()=>{
 it("uses PKCE S256/state/nonce and restores only the server-issued session",async()=>{
  const {location,cookie}=await flow();
  expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  expect(location.searchParams.get("nonce")).toBeTruthy();
  expect(cookie).not.toContain(location.searchParams.get("state")!);
  const request=new Request("http://localhost:3000/api/auth/callback?state="+location.searchParams.get("state")+"&code=test-code",{headers:{cookie}});
  const response=await finishLogin(request);
  expect(oidc.authorizationCodeGrant).toHaveBeenCalledWith(expect.anything(),expect.any(URL),{
   expectedState:location.searchParams.get("state"),expectedNonce:location.searchParams.get("nonce"),pkceCodeVerifier:expect.any(String),idTokenExpected:true
  });
  const session=response.headers.getSetCookie().find(v=>v.startsWith("jensen.session="))!.split(";")[0];
  const restored=await currentIdentity(new Request("http://localhost",{headers:{cookie:session}}));
  expect(restored?.email).toBe("owner@example.test");
  expect((await database().query("SELECT token_hash FROM sessions WHERE user_id=$1",[restored!.id])).rows[0].token_hash).toBe(hashToken(session.split("=")[1]));
  await expect(finishLogin(request)).rejects.toMatchObject({code:"invalid_login"});
 });
 it("rejects a different browser state before token exchange",async()=>{
  const {location,cookie}=await flow();
  await expect(finishLogin(new Request("http://localhost:3000/api/auth/callback?state=wrong&code=bad",{headers:{cookie}}))).rejects.toMatchObject({status:400});
  expect(oidc.authorizationCodeGrant).not.toHaveBeenCalled();
  await database().query("DELETE FROM login_states WHERE state_hash=$1",[hashToken(location.searchParams.get("state")!)]);
 });
 it("preserves state cookies through the correlated redirect wrapper",async()=>{
  await flow();
  const response=await login(new Request("http://localhost:3000/api/auth/login"));
  expect(response.status).toBe(303);expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  expect(response.headers.get("x-request-id")).toBeTruthy();
  const state=new URL(response.headers.get("location")!).searchParams.get("state")!;
  await database().query("DELETE FROM login_states WHERE state_hash=$1",[hashToken(state)]);
 });

 it("denies unauthenticated paid endpoints before provider calls and keeps demo non-spending",async()=>{
  vi.stubEnv("OPENAI_API_KEY","configured");
  const request=()=>new Request("http://localhost:3000/api/chat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({messages:[{role:"user",content:"hello"}]})});
  expect((await chat(request())).status).toBe(401);
  expect((await transcribe(new Request("http://localhost:3000/api/transcribe",{method:"POST"}))).status).toBe(401);
  vi.stubEnv("JENSEN_DEMO_MODE","true");
  expect((await chat(request())).status).toBe(200);
  expect((await transcribe(new Request("http://localhost:3000/api/transcribe",{method:"POST"}))).status).toBe(403);
  expect(createResponse).not.toHaveBeenCalled();expect(createTranscription).not.toHaveBeenCalled();
 });
});
