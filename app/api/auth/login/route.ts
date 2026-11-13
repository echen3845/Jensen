import { apiRoute } from "../../../../lib/api-errors";
import { beginLogin } from "../../../../lib/auth";
export async function GET(request: Request) { return apiRoute(request,"auth.login",beginLogin); }
