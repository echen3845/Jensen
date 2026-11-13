import {NextResponse} from "next/server";
import {apiRoute} from "../../../../lib/api-errors";
import {requireIdentity} from "../../../../lib/auth";
import {revokeGrant} from "../../../../lib/actions";
import {uuid} from "../../../../lib/store";
export async function DELETE(request:Request,ctx:{params:Promise<{id:string}>}){return apiRoute(request,"permissions.revoke",async r=>{
 await revokeGrant((await requireIdentity(r)).id,uuid((await ctx.params).id));return NextResponse.json({revoked:true});
});}
