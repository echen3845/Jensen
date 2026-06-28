import OpenAI from "openai";
import { NextResponse } from "next/server";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ChatMode = "standard" | "unhinged" | "flirty" | "therapist";

type OpenAIErrorLike = {
  status?: number;
  code?: string;
  type?: string;
  message?: string;
};

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

function parseChatMode(mode: unknown): ChatMode {
  if (mode === "unhinged" || mode === "flirty" || mode === "therapist") {
    return mode;
  }

  return "standard";
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

function isQuotaError(error: OpenAIErrorLike) {
  const text = `${error.code || ""} ${error.type || ""} ${error.message || ""}`.toLowerCase();
  return error.status === 429 || text.includes("quota") || text.includes("billing") || text.includes("credit");
}

export async function POST(request: Request) {
  const demoMode = process.env.JENSEN_DEMO_MODE === "true";
  const provider = getProviderConfig();

  const body = (await request.json()) as { messages?: ChatMessage[]; mode?: unknown };
  const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  const chatMode = parseChatMode(body.mode);

  if (messages.length === 0) {
    return NextResponse.json({ reply: "Tell me what you need and I will help." });
  }

  if (demoMode) {
    return NextResponse.json({ reply: getDemoReply(messages), mode: "demo" });
  }

  if (!provider.apiKey) {
    return NextResponse.json(
      {
        reply: provider.missingKeyReply
      },
      { status: 200 }
    );
  }

  const client = new OpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseURL
  });

  try {
    const response = await client.responses.create({
      model: provider.model,
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
    });

    return NextResponse.json({
      reply: response.output_text || "I heard you, but I could not form a response.",
      mode: "live",
      provider: provider.label,
      chatMode
    });
  } catch (error) {
    const openAIError = error as OpenAIErrorLike;

    if (isQuotaError(openAIError)) {
      return NextResponse.json(
        {
          reply:
            `Your ${provider.label} key is configured, but the account is out of API credits or billing is unavailable. Set JENSEN_DEMO_MODE=true in .env.local to use Jensen locally until credits are restored.`,
          mode: "blocked"
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        reply:
          `I could not reach the live ${provider.label} AI service. Check your key, model, credits, and network access. You can keep testing the app by setting JENSEN_DEMO_MODE=true in .env.local.`,
        mode: "error"
      },
      { status: 200 }
    );
  }
}
