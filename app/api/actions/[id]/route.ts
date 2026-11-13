import {NextResponse} from "next/server";
import {z} from "zod";
import {apiRoute} from "../../../../lib/api-errors";
import {requireIdentity} from "../../../../lib/auth";
import {approveAction,revokeAction,renewAction,createGrant} from "../../../../lib/actions";
import {parse,uuid} from "../../../../lib/store";
import {readLimitedJson} from "../../../../lib/request-resources";
export async function POST(request:Request,ctx:{params:Promise<{id:string}>}){return apiRoute(request,"actions.decide",async r=>{
 const user=await requireIdentity(r),id=uuid((await ctx.params).id);
 const input=parse(z.discriminatedUnion("decision",[
  z.object({decision:z.literal("approve"),hash:z.string().length(64)}).strict(),
  z.object({decision:z.literal("renew")}).strict(),
  z.object({decision:z.literal("grant"),hash:z.string().length(64),seconds:z.number().int().min(1).max(86400)}).strict()
 ]),await readLimitedJson(r,1024,5000));
 if(input.decision==="approve")return NextResponse.json({approved:true,taskId:await approveAction(user.id,id,input.hash)});
 if(input.decision==="renew")return NextResponse.json({hash:await renewAction(user.id,id)});
 return NextResponse.json({grantId:await createGrant(user.id,id,input.hash,input.seconds)});
});}
export async function DELETE(request:Request,ctx:{params:Promise<{id:string}>}){return apiRoute(request,"actions.revoke",async r=>{
 await revokeAction((await requireIdentity(r)).id,uuid((await ctx.params).id));return NextResponse.json({revoked:true});
});}
