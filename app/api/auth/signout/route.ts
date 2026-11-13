import { apiRoute } from "../../../../lib/api-errors";
import { signOut } from "../../../../lib/auth";
export async function POST(request: Request) { return apiRoute(request,"auth.signout",signOut); }
