// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,describe,expect,it,vi} from "vitest";
import TaskPanel from "../app/task-panel";
afterEach(cleanup);
describe("action review controls",()=>{
 it("submits the displayed exact hash and expected account without accepting tool instructions as approval",async()=>{
  vi.mocked(fetch).mockImplementation(async(input)=>{
   const path=String(input);
   const body=path==="/api/auth/session"?{user:{id:"owner"}}:path==="/api/tasks"?{tasks:[]}:path==="/api/actions"?{actions:[{
    id:"action",task_id:"task",preview:"Save tone = concise",action_hash:"a".repeat(64),status:"pending",effect:"reversible",arguments:{key:"tone",value:"concise"},expires_at:new Date(Date.now()+60000).toISOString()
   }]}:path==="/api/grants"?{grants:[]}:{approved:true};
   return new Response(JSON.stringify(body),{headers:{"content-type":"application/json"}});
  });
  render(<TaskPanel userId="owner"/>);
  await waitFor(()=>expect((screen.getByRole("button",{name:"Approve once"}) as HTMLButtonElement).disabled).toBe(false));
  expect(fetch).not.toHaveBeenCalledWith("/api/actions/action",expect.anything());
  fireEvent.click(screen.getByRole("button",{name:"Approve once"}));
  await waitFor(()=>expect(fetch).toHaveBeenCalledWith("/api/actions/action",expect.objectContaining({method:"POST"})));
  const options=vi.mocked(fetch).mock.calls.find(([url])=>url==="/api/actions/action")![1]!;
  expect(JSON.parse(options.body as string)).toEqual({decision:"approve",hash:"a".repeat(64)});
  expect(options.headers).toMatchObject({"x-jensen-user":"owner"});
 });
});
