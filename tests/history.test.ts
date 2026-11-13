// @vitest-environment jsdom
import {act,cleanup,renderHook,waitFor} from "@testing-library/react";
import {afterEach,describe,expect,it,vi} from "vitest";
import {useHistory,removeLegacyHistory} from "../lib/use-history";
const welcome=[{id:"welcome",role:"assistant" as const,content:"Welcome"}];
afterEach(cleanup);
describe("history isolation",()=>{
 it("ignores malformed legacy data and denied storage without crashing demo mode",async()=>{
  window.localStorage.setItem("jensen.messages","malformed JSON");
  removeLegacyHistory();expect(window.localStorage.getItem("jensen.messages")).toBe(null);
  vi.spyOn(Storage.prototype,"removeItem").mockImplementation(()=>{throw new Error("denied");});
  const {result}=renderHook(()=>useHistory(null,welcome));
  expect(result.current.messages).toEqual(welcome);expect(result.current.ready).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
 });
 it("bounds visible history and clears it on scope invalidation",async()=>{
  const {result}=renderHook(()=>useHistory(null,welcome));
  act(()=>result.current.setMessages(Array.from({length:1000},(_,i)=>({id:String(i),role:"user",content:"x"}))));
  expect(result.current.messages).toHaveLength(100);
  act(()=>result.current.clearScope());
  expect(result.current.messages).toEqual(welcome);expect(result.current.ready).toBe(false);
 });
 it("discards a delayed account A history response after switching to B",async()=>{
  let resolveA:(r:Response)=>void=()=>{};
  vi.mocked(fetch).mockImplementation(async(input)=>{
   const url=String(input);
   if(url==="/api/auth/session")return new Response(JSON.stringify({user:{id:account}}));
   if(url==="/api/conversations")return new Response(JSON.stringify({conversations:[{id:account,title:"Owned"}]}));
   if(url==="/api/conversations/A")return new Promise(resolve=>{resolveA=resolve;});
   return new Response(JSON.stringify({messages:[{id:"b",role:"user",content:"B history"}],cursor:"1",hasMore:false}));
  });
  let account="A";
  const {result,rerender}=renderHook(({id})=>useHistory(id,welcome),{initialProps:{id:"A"}});
  await waitFor(()=>expect(fetch).toHaveBeenCalledWith("/api/conversations/A",expect.anything()));
  account="B";rerender({id:"B"});
  await waitFor(()=>expect(result.current.messages[0].content).toBe("B history"));
  await act(async()=>{resolveA(new Response(JSON.stringify({messages:[{id:"a",role:"user",content:"A private history"}],cursor:"1",hasMore:false})));});
  expect(result.current.messages[0].content).toBe("B history");
 });
});
