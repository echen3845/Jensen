import { apiRoute } from "../../../../lib/api-errors";
import { finishLogin } from "../../../../lib/auth";
export async function GET(request: Request) { return apiRoute(request,"auth.callback",finishLogin); }
