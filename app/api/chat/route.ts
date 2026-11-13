import { apiRoute, ApiError } from "../../../lib/api-errors";
import OpenAI from "openai";
import { NextResponse } from "next/server";
import { getResourceLimits } from "../../../lib/resource-limits";
import { budgetMessages } from "../../../lib/chat-budget";
import { readLimitedJson, withDeadline } from "../../../lib/request-resources";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ChatMode = "standard" | "unhinged" | "flirty" | "therapist";


const modeInstructions: Record<ChatMode, string> = {
  standard:
    "Be calm, capable, concise, and practical. Ask focused follow-up questions when context is missing.",
  unhinged:
    "Be chaotic, witty, blunt, and high-energy, but keep it useful. Do not use hateful, explicit, or genuinely abusive content.",
  flirty:
    "Be playful, warm, confident, and lightly flirty. Keep it PG-13 and never become sexually explicit.",
  therapist:
    "Be emotionally steady, reflective, and supportive. You are not a licensed therapist; avoid diagnosis and encourage professional help for serious mental health concerns."
};

function getSystemPrompt(mode: ChatMode) {
  return `You are Jensen, a personal AI assistant inspired by cinematic voice assistants.
You help the user think, plan, draft, summarize, and operate their day.
Mode: ${mode}.
${modeInstructions[mode]}
When a request implies a real-world action you cannot perform yet, say what you would need connected as a tool.`;
}

function getProviderConfig() {
  const provider = (process.env.AI_PROVIDER || "openai").toLowerCase();

  if (provider === "xai" || provider === "grok") {
    return {
      label: "xai",
      apiKey: process.env.XAI_API_KEY,
      model: process.env.XAI_MODEL || "grok-4.3",
      baseURL: "https://api.x.ai/v1",
      missingKeyReply:
        "Jensen is set to Grok/xAI mode, but XAI_API_KEY is not configured. Add XAI_API_KEY to .env.local and restart the dev server."
    };
  }

  return {
    label: "openai",
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    baseURL: undefined,
    missingKeyReply:
      "Jensen is set to OpenAI mode, but OPENAI_API_KEY is not configured. Add OPENAI_API_KEY to .env.local and restart the dev server."
  };
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const message = value as Record<string, unknown>;
  return (message.role === "user" || message.role === "assistant") && typeof message.content === "string";
}

function isChatMode(value: unknown): value is ChatMode {
  return value === "standard" || value === "unhinged" || value === "flirty" || value === "therapist";
}

function getDemoReply(messages: ChatMessage[]) {
  const latest = messages.at(-1)?.content || "";

  if (/remember|note|save/i.test(latest)) {
    return "Demo mode: I can stage that as a memory note, but long-term memory is not connected yet. Next step is adding an encrypted memory store.";
  }

  if (/plan|tomorrow|schedule/i.test(latest)) {
    return "Demo mode: here is a clean first pass. Pick your top three priorities, block one focused work session, leave one recovery gap, and end with a short review.";
  }

  if (/draft|write|text|email/i.test(latest)) {
    return "Demo mode: I can draft that. Give me the recipient, tone, and the core point you want to land, and I will shape it.";
  }

  return "Demo mode online. I can run the interface, voice controls, and local workflow without API credits. Connect billing later to enable live AI reasoning.";
}

export async function POST(request: Request) {
  return apiRoute(request, "chat", handleChat);
}

async function handleChat(request: Request) {
  const limits = getResourceLimits();
  const body = await readLimitedJson(request, limits.chatBodyBytes, limits.bodyTimeoutMs);

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid chat payload." }, { status: 400 });
  }

  const payload = body as Record<string, unknown>;
  if (!Array.isArray(payload.messages) || !payload.messages.every(isChatMessage) ||
      (payload.mode !== undefined && !isChatMode(payload.mode))) {
    return NextResponse.json({ error: "Invalid chat payload." }, { status: 400 });
  }

  const chatMode = payload.mode === undefined ? "standard" : payload.mode as ChatMode;
  const messages = budgetMessages(payload.messages, getSystemPrompt(chatMode), limits);
  const demoMode = process.env.JENSEN_DEMO_MODE === "true";
  const provider = getProviderConfig();

  if (messages.length === 0) {
    return NextResponse.json({ reply: "Tell me what you need and I will help." });
  }

  if (demoMode) {
    return NextResponse.json({ reply: getDemoReply(messages), mode: "demo" });
  }

  if (!provider.apiKey) throw new ApiError(503, "provider_configuration", "The chat provider is not configured.");

  const client = new OpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
    timeout: limits.providerTimeoutMs,
    maxRetries: limits.providerRetries
  });

    const response = await withDeadline(request.signal, limits.providerTimeoutMs, (signal) => client.responses.create({
      model: provider.model,
      max_output_tokens: limits.outputTokens,
      input: [
        {
          role: "system",
          content: getSystemPrompt(chatMode)
        },
        ...messages.map((message) => ({
          role: message.role,
          content: message.content
        }))
      ]
    }, { signal, timeout: limits.providerTimeoutMs, maxRetries: limits.providerRetries }));

    return NextResponse.json({
      reply: response.output_text || "I heard you, but I could not form a response.",
      mode: "live",
      provider: provider.label,
      chatMode
    });
}
