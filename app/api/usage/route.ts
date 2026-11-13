import {NextResponse} from "next/server";
import {apiRoute} from "../../../lib/api-errors";
import {requireIdentity} from "../../../lib/auth";
import {database} from "../../../lib/db";
export async function GET(request:Request){return apiRoute(request,"usage.read",async r=>{
 const user=await requireIdentity(r);
 const windows=await database().query("SELECT bucket,spent::text,reserved::text,requests FROM usage_windows WHERE user_id=$1 ORDER BY bucket DESC LIMIT 31",[user.id]);
 return NextResponse.json({unit:"configured-micro-USD",windows:windows.rows});
});}
