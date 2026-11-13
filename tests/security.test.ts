import {describe,expect,it,vi} from "vitest";
import type {lookup} from "node:dns/promises";
import {publicAddress,inspectTarget} from "../lib/safe-fetch";
import {safeData,sealCredential,openCredential} from "../lib/secrets";
describe("network and credential boundaries",()=>{
 it.each(["127.0.0.1","10.0.0.1","172.16.0.1","192.168.1.1","169.254.169.254","100.64.0.1","224.0.0.1","0.0.0.0","192.0.2.1","::1","::ffff:127.0.0.1","fc00::1","fe80::1","2001:db8::1"])("rejects non-public %s",address=>expect(publicAddress(address)).toBe(false));
 it.each(["1.1.1.1","8.8.8.8","2606:4700:4700::1111"])("accepts public %s",address=>expect(publicAddress(address)).toBe(true));
 it.each(["http://example.org","https://user:password@example.org","https://127.0.0.1","https://0177.0.0.1","https://[::ffff:127.0.0.1]","https://localhost","https://example.org:8443","https://example.org/?access_token=x"])("rejects unsafe URL %s",async url=>{await expect(inspectTarget(url)).rejects.toBeDefined();});
 it("rejects mixed public/private DNS and pins verified addresses",async()=>{
  const mixed=vi.fn(async()=>[{address:"1.1.1.1",family:4},{address:"127.0.0.1",family:4}]) as unknown as typeof lookup;
  await expect(inspectTarget("https://example.test",mixed)).rejects.toMatchObject({code:"network_target_blocked"});
  const resolver=vi.fn(async()=>[{address:"1.1.1.1",family:4}]) as unknown as typeof lookup;
  expect((await inspectTarget("https://example.test",resolver)).addresses).toEqual([{address:"1.1.1.1",family:4}]);
  expect(resolver).toHaveBeenCalledOnce();
 });
 it("binds ciphertext to owner/account/provider",()=>{
  vi.stubEnv("JENSEN_CREDENTIAL_KEYS",JSON.stringify({v1:Buffer.alloc(32,1).toString("base64")}));
  vi.stubEnv("JENSEN_ACTIVE_CREDENTIAL_KEY","v1");
  const encrypted=sealCredential("A","account","gmail","private-refresh-token");
  expect(encrypted.toString()).not.toContain("private-refresh-token");
  expect(openCredential("A","account","gmail",encrypted)).toBe("private-refresh-token");
  expect(()=>openCredential("B","account","gmail",encrypted)).toThrow();
  expect(()=>openCredential("A","other","gmail",encrypted)).toThrow();
  const changed=Buffer.from(encrypted);changed[changed.length-5]^=1;
  expect(()=>openCredential("A","account","gmail",changed)).toThrow();
 });
 it("redacts nested credentials and configured secrets",()=>{
  vi.stubEnv("OPENAI_API_KEY","my-private-provider-key");
  expect(JSON.stringify(safeData({text:"Leaked my-private-provider-key",nested:{authorization:"Bearer abc",refresh_token:"raw"}}))).not.toMatch(/my-private-provider-key|Bearer abc|"raw"/);
 });
});
