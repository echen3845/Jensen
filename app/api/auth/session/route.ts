import { NextResponse } from "next/server";
import { apiRoute } from "../../../../lib/api-errors";
import { currentIdentity } from "../../../../lib/auth";
export async function GET(request: Request) {
 return apiRoute(request,"auth.session",async r => NextResponse.json({user:await currentIdentity(r)}));
}
