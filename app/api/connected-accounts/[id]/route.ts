import {NextResponse} from "next/server";
import {apiRoute} from "../../../../lib/api-errors";
import {requireIdentity} from "../../../../lib/auth";
import {disconnectAccount} from "../../../../lib/secrets";
import {uuid} from "../../../../lib/store";
export async function DELETE(request:Request,ctx:{params:Promise<{id:string}>}){return apiRoute(request,"connections.disconnect",async r=>{
 await disconnectAccount((await requireIdentity(r)).id,uuid((await ctx.params).id));
 return NextResponse.json({disconnected:true,note:"Local credentials deleted. Provider-side revocation depends on the connector."});
});}
