import {z} from "zod";
import {parse,uuid} from "../../../lib/store";
import {newTask,taskFor} from "../../../lib/task-service";
import {readLimitedJson} from "../../../lib/request-resources";
import { NextResponse } from "next/server";
import { apiRoute } from "../../../lib/api-errors";
import { requireIdentity } from "../../../lib/auth";
import { ownedRows } from "../../../lib/store";
export async function GET(request:Request) {return apiRoute(request,"tasks.list",async r=>NextResponse.json({tasks:await ownedRows((await requireIdentity(r)).id,"tasks")}));}

export async function POST(request:Request){return apiRoute(request,"tasks.create",async r=>{
 const user=await requireIdentity(r);
 const input=parse(z.object({prompt:z.string().min(1).max(8192)}).strict(),await readLimitedJson(r,16384,5000));
 const requestId=r.headers.get("idempotency-key");
 const task=await newTask(user.id,input.prompt,requestId?uuid(requestId):undefined);
 return NextResponse.json({task:await taskFor(user.id,task.id),queued:task.created}, {status:202});
});}
