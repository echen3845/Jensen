import {NextResponse} from "next/server";
import {apiRoute} from "../../../../lib/api-errors";
import {requireIdentity} from "../../../../lib/auth";
import {taskFor,cancelTask} from "../../../../lib/task-service";
export async function GET(request:Request,ctx:{params:Promise<{id:string}>}){return apiRoute(request,"tasks.inspect",async r=>NextResponse.json({task:await taskFor((await requireIdentity(r)).id,(await ctx.params).id)}));}
export async function DELETE(request:Request,ctx:{params:Promise<{id:string}>}){return apiRoute(request,"tasks.cancel",async r=>{
 const user=await requireIdentity(r);await cancelTask(user.id,(await ctx.params).id);return NextResponse.json({cancelled:true,note:"Earlier actions may already be completed. Review receipts."});
});}
