import {NextResponse} from "next/server";
import {apiRoute} from "../../../../../lib/api-errors";
import {requireIdentity} from "../../../../../lib/auth";
import {executeInline} from "../../../../../lib/task-service";
export async function POST(request:Request,ctx:{params:Promise<{id:string}>}){return apiRoute(request,"tasks.resume",async r=>{
 const user=await requireIdentity(r);return NextResponse.json({task:await executeInline(user.id,(await ctx.params).id,r.signal)});
});}
