import type { ResourceLimits } from "./resource-limits";
import { RequestError } from "./request-resources";

type Message = { role: "user" | "assistant"; content: string };

// Budget UTF-8 bytes plus conservative per-message framing overhead. This is
// intentionally provider-independent; it is not an exact tokenizer count.
export function budgetMessages(messages: Message[], systemPrompt: string, limits: ResourceLimits) {
  if (messages.length > limits.maxMessages) {
    throw new RequestError(413, "too_many_messages", "Too many messages in this request.");
  }
  const encoder = new TextEncoder();
  for (const message of messages) {
    if (encoder.encode(message.content).byteLength > limits.messageBytes) {
      throw new RequestError(413, "message_too_large", "A message exceeds the byte limit.");
    }
  }
  let remaining = limits.inputBytes - encoder.encode(systemPrompt).byteLength - 128;
  const selected: Message[] = [];
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - 12); i--) {
    const cost = encoder.encode(messages[i].content).byteLength + 128;
    if (cost > remaining) {
      if (selected.length === 0) {
        throw new RequestError(413, "context_too_large", "The latest message exceeds the model input budget.");
      }
      break;
    }
    selected.unshift(messages[i]);
    remaining -= cost;
  }
  if (remaining < 0) throw new RequestError(413, "context_too_large", "Model input budget is too small.");
  return selected;
}
