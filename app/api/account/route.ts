import { NextResponse } from "next/server";
import { apiRoute } from "../../../lib/api-errors";
import { requireIdentity,signOut } from "../../../lib/auth";
import { exportAccount,deleteAccount } from "../../../lib/store";
export async function GET(request:Request) {return apiRoute(request,"account.export",async r=>NextResponse.json(await exportAccount((await requireIdentity(r)).id)));}
export async function DELETE(request:Request) {return apiRoute(request,"account.delete",async r=>{
 const user=await requireIdentity(r);
 await deleteAccount(user.id);
 return signOut(r);
});}
