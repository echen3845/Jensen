import { NextResponse } from "next/server";
import { z } from "zod";
import { apiRoute } from "../../../lib/api-errors";
import { requireIdentity } from "../../../lib/auth";
import { parse,preferences,savePreference,deletePreference } from "../../../lib/store";
import { readLimitedJson } from "../../../lib/request-resources";
export async function GET(request:Request) {return apiRoute(request,"preferences.list",async r=>NextResponse.json({preferences:await preferences((await requireIdentity(r)).id)}));}
export async function PUT(request:Request) {return apiRoute(request,"preferences.save",async r=>{
 const user=await requireIdentity(r);
 const input=parse(z.object({key:z.string().min(1).max(64),value:z.string().max(1024)}).strict(),await readLimitedJson(r,4096,5000));
 await savePreference(user.id,input.key,input.value);
 return NextResponse.json({saved:true});
});}
export async function DELETE(request:Request) {return apiRoute(request,"preferences.delete",async r=>{
 const user=await requireIdentity(r);
 const input=parse(z.object({key:z.string().min(1).max(64)}).strict(),await readLimitedJson(r,1024,5000));
 await deletePreference(user.id,input.key);
 return NextResponse.json({deleted:true});
});}
