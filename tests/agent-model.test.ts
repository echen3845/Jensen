import {describe,expect,it,vi} from "vitest";
import {modelFor} from "../lib/agent";
import {tools} from "../lib/tools";
import {createResponse} from "./mocks/openai";
describe("registered provider tool path",()=>{
 it("sends schemas as model hints while server validation remains authoritative",async()=>{
  vi.stubEnv("OPENAI_API_KEY","test-provider-key");
  createResponse.mockResolvedValueOnce({output_text:"Answer"});
  const result=await modelFor("owner")([{role:"user",content:"Read my preferences"}],tools,new AbortController().signal);
  expect(result).toEqual({text:"Answer",calls:[]});
  const params=createResponse.mock.calls[0][0] as {tools:{name:string;strict:boolean;parameters:unknown}[]};
  expect(params.tools).toHaveLength(3);
  for(const tool of params.tools){expect(tool.name).toMatch(/^[a-z0-9_-]+$/);expect(tool.strict).toBe(false);expect(tool.parameters).toBeDefined();}
 });
});
