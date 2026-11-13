import {NextResponse} from "next/server";
import {apiRoute} from "../../../lib/api-errors";
import {requireIdentity} from "../../../lib/auth";
import {transaction} from "../../../lib/db";
export async function GET(request:Request){return apiRoute(request,"permissions.list",async r=>{
 const user=await requireIdentity(r);
 const grants=await transaction(async c=>(await c.query("SELECT id,tool,tool_version,argument_hash,expires_at,revoked_at FROM permission_grants WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",[user.id])).rows,user.id);
 return NextResponse.json({grants});
});}
