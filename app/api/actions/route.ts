import {NextResponse} from "next/server";
import {apiRoute} from "../../../lib/api-errors";
import {requireIdentity} from "../../../lib/auth";
import {transaction} from "../../../lib/db";
export async function GET(request:Request){return apiRoute(request,"actions.list",async r=>{
 const user=await requireIdentity(r);
 const actions=await transaction(async c=>(await c.query("SELECT id,task_id,tool,tool_version,arguments,action_hash,preview,effect,required_permissions,status,expires_at,result FROM actions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",[user.id])).rows,user.id);
 return NextResponse.json({actions});
});}
