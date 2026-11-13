import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { EncryptJWT, jwtDecrypt } from "jose";
import * as oidc from "openid-client";
import { ApiError } from "./api-errors";
import { database, transaction } from "./db";
import { throttleAnonymous } from "./quotas";

export type Identity = { id: string; email: string | null };
const sessionCookie = () => applicationUrl().protocol==="https:" ? "__Host-jensen.session" : "jensen.session";
const flowCookie = () => applicationUrl().protocol==="https:" ? "__Host-jensen.login" : "jensen.login";
export function applicationUrl() {
  const url = new URL(process.env.APP_URL || "http://localhost:3000");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (url.protocol !== "https:" && !((process.env.NODE_ENV !== "production" || localDemo()) && ["localhost","127.0.0.1","[::1]"].includes(url.hostname)))) {
    throw new ApiError(503,"auth_configuration","APP_URL must be an HTTPS origin (loopback HTTP only in development).");
  }
  return url;
}
function cookieOptions() {
  return { httpOnly: true, secure: applicationUrl().protocol === "https:", sameSite: "lax" as const, path: "/" };
}
export const hashToken = (value: string) => createHash("sha256").update(value).digest("hex");
function cookie(request: Request, name: string) {
  const entry = request.headers.get("cookie")?.split(";").map(s => s.trim()).find(s => s.startsWith(name + "="));
  return entry?.slice(name.length + 1);
}
function authKey() {
  const key = Buffer.from(process.env.AUTH_SECRET || "", "base64");
  if (key.length !== 32) throw new ApiError(503,"auth_configuration","Configure a 32-byte base64 AUTH_SECRET.");
  return key;
}
export function checkOrigin(request: Request) {
  if (request.headers.get("origin") !== applicationUrl().origin) {
    throw new ApiError(403,"origin_rejected","This action requires a same-origin request.");
  }
}
export async function currentIdentity(request: Request): Promise<Identity | null> {
  const token = cookie(request, sessionCookie());
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const result = await database().query(
    "SELECT u.id,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()",
    [hashToken(token)]);
  return result.rows[0] || null;
}
export async function requireIdentity(request: Request, mutation = true) {
  const user = await currentIdentity(request);
  if (!user) { await throttleAnonymous(request); throw new ApiError(401,"authentication_required","Sign in to continue."); }
  const expected=request.headers.get("x-jensen-user");
  if(expected&&expected!==user.id)throw new ApiError(403,"session_changed","Session changed. Reload before continuing.");
  if (mutation && !["GET","HEAD"].includes(request.method)) checkOrigin(request);
  return user;
}
export function localDemo() { return process.env.JENSEN_DEMO_MODE === "true"; }
let configuration: Promise<oidc.Configuration> | undefined;
async function provider() {
  if (!process.env.OIDC_ISSUER || !process.env.OIDC_CLIENT_ID || !process.env.OIDC_CLIENT_SECRET) {
    throw new ApiError(503,"auth_configuration","Configure the OIDC sign-in provider.");
  }
  if (new URL(process.env.OIDC_ISSUER).protocol !== "https:") throw new ApiError(503,"auth_configuration","OIDC issuer must use HTTPS.");
  return configuration ??= oidc.discovery(new URL(process.env.OIDC_ISSUER), process.env.OIDC_CLIENT_ID,
    { client_secret: process.env.OIDC_CLIENT_SECRET }, undefined, { timeout: 10 });
}
export async function beginLogin(request?:Request) {
  if(request)await throttleAnonymous(request);
  const state = oidc.randomState(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const encrypted = await new EncryptJWT({ state,nonce,verifier }).setProtectedHeader({ alg:"dir",enc:"A256GCM" })
    .setIssuedAt().setIssuer("jensen-login").setAudience("jensen-callback").setExpirationTime("10m").encrypt(authKey());
  const url = oidc.buildAuthorizationUrl(await provider(), {
    redirect_uri: new URL("/api/auth/callback",applicationUrl()).href,
    scope:"openid email", response_type:"code", state, nonce, code_challenge:challenge, code_challenge_method:"S256"
  });
  await database().query("INSERT INTO login_states VALUES($1,now()+interval '10 minutes')", [hashToken(state)]);
  const response = NextResponse.redirect(url,303);
  response.cookies.set(flowCookie(),encrypted,{...cookieOptions(),maxAge:600});
  return response;
}
export async function finishLogin(request: Request) {
  const raw = cookie(request,flowCookie());
  if (!raw) throw new ApiError(400,"invalid_login","Login expired. Start sign-in again.");
  let flow;
  try { flow = (await jwtDecrypt(raw,authKey(),{issuer:"jensen-login",audience:"jensen-callback"})).payload; }
  catch { throw new ApiError(400,"invalid_login","Login expired. Start sign-in again."); }
  if (typeof flow.state !== "string" || typeof flow.nonce !== "string" || typeof flow.verifier !== "string") {
    throw new ApiError(400,"invalid_login","Invalid sign-in state.");
  }
  const current = new URL("/api/auth/callback",applicationUrl());
  current.search = new URL(request.url).search;
  if (current.searchParams.get("state") !== flow.state) throw new ApiError(400,"invalid_login","Sign-in state did not match.");
  const consumed = await database().query("DELETE FROM login_states WHERE state_hash=$1 AND expires_at>now() RETURNING state_hash",[hashToken(flow.state)]);
  if (!consumed.rowCount) throw new ApiError(400,"invalid_login","Sign-in already used or expired.");
  const tokens = await oidc.authorizationCodeGrant(await provider(),current,{
    pkceCodeVerifier:flow.verifier,expectedState:flow.state,expectedNonce:flow.nonce,idTokenExpected:true
  });
  const claims = tokens.claims();
  if (!claims?.sub || claims.iss !== process.env.OIDC_ISSUER) throw new ApiError(403,"invalid_identity","Invalid sign-in identity.");
  const email = claims.email_verified === true && typeof claims.email === "string" ? claims.email.toLowerCase() : null;
  const allow = process.env.JENSEN_ALLOWED_EMAILS?.split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
  if (allow?.length && (!email || !allow.includes(email))) throw new ApiError(403,"account_not_allowed","This account is not allowed.");
  const token = randomBytes(32).toString("hex");
  await transaction(async client => {
    const user = await client.query("INSERT INTO users(issuer,subject,email) VALUES($1,$2,$3) ON CONFLICT(issuer,subject) DO UPDATE SET email=excluded.email RETURNING id",
      [claims.iss,claims.sub,email]);
    await client.query("INSERT INTO sessions VALUES($1,$2,now()+interval '12 hours')",[hashToken(token),user.rows[0].id]);
  });
  const response = NextResponse.redirect(applicationUrl(),303);
  response.cookies.set(flowCookie(),"",{...cookieOptions(),maxAge:0});
  response.cookies.set(sessionCookie(),token,{...cookieOptions(),maxAge:43200});
  return response;
}
export async function signOut(request: Request) {
  checkOrigin(request);
  if(request.headers.has("x-jensen-user"))await requireIdentity(request);
  const token = cookie(request,sessionCookie());
  if (token) await database().query("DELETE FROM sessions WHERE token_hash=$1",[hashToken(token)]);
  const response = NextResponse.json({signedOut:true});
  response.cookies.set(sessionCookie(),"",{...cookieOptions(),maxAge:0});
  response.cookies.set(flowCookie(),"",{...cookieOptions(),maxAge:0});
  return response;
}
