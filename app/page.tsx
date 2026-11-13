import { headers } from "next/headers";
import Assistant from "./assistant";
import { getClientLimits } from "../lib/resource-limits";
import { applicationUrl,currentIdentity,localDemo } from "../lib/auth";
export const dynamic="force-dynamic";
export default async function Home() {
 const identity=await currentIdentity(new Request(applicationUrl(),{headers:await headers()}));
 if(!identity&&!localDemo())return <main className="shell"><section className="workspace">
  <h1>Jensen</h1><p>Sign in to access your personal assistant.</p>
  <a href="/api/auth/login">Sign in</a>
 </section></main>;
 return <Assistant key={identity?.id||"demo"} limits={getClientLimits()} identity={identity}/>;
}
