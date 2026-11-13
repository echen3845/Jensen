import { NextResponse } from "next/server";
import { apiRoute } from "../../../lib/api-errors";
import { requireIdentity } from "../../../lib/auth";
import { ownedRows } from "../../../lib/store";
export async function GET(request:Request) {return apiRoute(request,"tasks.list",async r=>NextResponse.json({tasks:await ownedRows((await requireIdentity(r)).id,"tasks")}));}
