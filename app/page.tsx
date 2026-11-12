import Assistant from "./assistant";
import { getClientLimits } from "../lib/resource-limits";

// Read runtime server configuration rather than baking limits into a static build.
export const dynamic = "force-dynamic";

export default function Home() {
  return <Assistant limits={getClientLimits()} />;
}
