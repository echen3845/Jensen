import {NextResponse} from "next/server";
import {apiRoute} from "../../../lib/api-errors";
import {requireIdentity} from "../../../lib/auth";
import {ownedRows} from "../../../lib/store";
export async function GET(request:Request){return apiRoute(request,"connections.list",async r=>NextResponse.json({accounts:await ownedRows((await requireIdentity(r)).id,"connected_accounts")}));}
