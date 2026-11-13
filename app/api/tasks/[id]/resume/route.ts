import {NextResponse} from "next/server";
import {apiRoute} from "../../../../../lib/api-errors";
import {requireIdentity} from "../../../../../lib/auth";
import {taskFor} from "../../../../../lib/task-service";
import {enqueueTask} from "../../../../../lib/queue";
import {uuid} from "../../../../../lib/store";
export async function POST(request:Request,ctx:{params:Promise<{id:string}>}){return apiRoute(request,"tasks.resume",async r=>{
 const user=await requireIdentity(r),id=uuid((await ctx.params).id);
 await enqueueTask(user.id,id);return NextResponse.json({task:await taskFor(user.id,id),queued:true},{status:202});
});}
