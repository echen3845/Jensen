import type { ClientLimits } from "./resource-limits";

type Message = { role: "user" | "assistant"; content: string };
type ChatLimits = Pick<ClientLimits, "maxMessages" | "messageBytes" | "chatBodyBytes">;

type ChatRequest = { ok: true; body: string } | { ok: false; error: string };

// Preserve a contiguous recent suffix, measuring the same JSON sent over HTTP.
// Do not mutate or truncate the displayed conversation or the newest prompt.
export function buildChatRequest(history: readonly Message[], mode: string, limits: ChatLimits): ChatRequest {
  const encoder = new TextEncoder();
  const selected: Message[] = [];
  let bytes = encoder.encode(JSON.stringify({ messages: [], mode })).byteLength;
  const minimum = Math.max(0, history.length - limits.maxMessages);

  for (let i = history.length - 1; i >= minimum; i--) {
    const { role, content } = history[i];
    if (encoder.encode(content).byteLength > limits.messageBytes) break;
    const message = { role, content };
    const cost = encoder.encode(JSON.stringify(message)).byteLength + (selected.length ? 1 : 0);
    if (bytes + cost > limits.chatBodyBytes) break;
    selected.unshift(message);
    bytes += cost;
  }

  if (!selected.length) {
    return { ok: false, error: "Message is too long for this request. Please shorten it." };
  }
  return { ok: true, body: JSON.stringify({ messages: selected, mode }) };
}
