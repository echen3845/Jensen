import OpenAI from "openai";
import { NextResponse } from "next/server";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type OpenAIErrorLike = {
  status?: number;
  code?: string;
  type?: string;
  message?: string;
};

const systemPrompt = `You are Jensen, a calm, capable personal AI assistant inspired by cinematic voice assistants.
You help the user think, plan, draft, summarize, and operate their day.
Be concise by default. Ask focused follow-up questions when a request needs missing context.
When a request implies a real-world action you cannot perform yet, say what you would need connected as a tool.`;

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
  const apiKey = process.env.OPENAI_API_KEY;
  const demoMode = process.env.JENSEN_DEMO_MODE === "true";

  const body = (await request.json()) as { messages?: ChatMessage[] };
  const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];

  if (messages.length === 0) {
    return NextResponse.json({ reply: "Tell me what you need and I will help." });
  }

  if (demoMode) {
    return NextResponse.json({ reply: getDemoReply(messages), mode: "demo" });
  }

  if (!apiKey) {
    return NextResponse.json(
      {
        reply:
          "I am online locally, but the OpenAI API key is not configured yet. Add OPENAI_API_KEY to .env.local and restart the dev server."
      },
      { status: 200 }
    );
  }

  const client = new OpenAI({ apiKey });

  try {
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: systemPrompt
        },
        ...messages.map((message) => ({
          role: message.role,
          content: message.content
        }))
      ]
    });

    return NextResponse.json({
      reply: response.output_text || "I heard you, but I could not form a response.",
      mode: "live"
    });
  } catch (error) {
    const openAIError = error as OpenAIErrorLike;

    if (isQuotaError(openAIError)) {
      return NextResponse.json(
        {
          reply:
            "Your OpenAI key is configured, but the account is out of API credits or billing is unavailable. Set JENSEN_DEMO_MODE=true in .env.local to use Jensen locally until credits are restored.",
          mode: "blocked"
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        reply:
          "I could not reach the live AI service. You can keep testing the app by setting JENSEN_DEMO_MODE=true in .env.local.",
        mode: "error"
      },
      { status: 200 }
    );
  }
}
