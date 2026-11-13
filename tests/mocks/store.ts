import { vi } from "vitest";
let latest="";
export const createConversation=vi.fn(async()=>({id:"10000000-0000-4000-8000-000000000001"}));
export const beginTurn=vi.fn(async(_user:string,_conversation:string,_id:string,content:string)=>{latest=content;return{seq:"1"};});
export const serverContext=vi.fn(async()=>[{role:"user" as const,content:latest}]);
export const finishTurn=vi.fn(async()=>{});
