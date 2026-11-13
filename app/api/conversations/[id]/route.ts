import { NextResponse } from "next/server";
import { apiRoute } from "../../../../lib/api-errors";
import { requireIdentity } from "../../../../lib/auth";
import { messagePage } from "../../../../lib/store";
export async function GET(request:Request,context:{params:Promise<{id:string}>}) {
 return apiRoute(request,"conversations.history",async r=>{
  const user=await requireIdentity(r);
  return NextResponse.json(await messagePage(user.id,(await context.params).id,new URL(r.url).searchParams.get("before")||undefined));
 });
}
