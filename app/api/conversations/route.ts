import { NextResponse } from "next/server";
import { z } from "zod";
import { apiRoute } from "../../../lib/api-errors";
import { requireIdentity } from "../../../lib/auth";
import { conversations,createConversation,parse } from "../../../lib/store";
import { readLimitedJson } from "../../../lib/request-resources";
export async function GET(request:Request) {
 return apiRoute(request,"conversations.list",async r=>NextResponse.json({conversations:await conversations((await requireIdentity(r)).id)}));
}
export async function POST(request:Request) {
 return apiRoute(request,"conversations.create",async r=>{
  const user=await requireIdentity(r);
  const input=parse(z.object({title:z.string().trim().min(1).max(120).optional()}).strict(),await readLimitedJson(r,1024,5000));
  return NextResponse.json({conversation:await createConversation(user.id,input.title)}, {status:201});
 });
}
