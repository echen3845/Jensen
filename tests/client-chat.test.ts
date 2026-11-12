import { describe, expect, it, vi } from "vitest";
import { buildChatRequest } from "../lib/client-chat";
import { getClientLimits } from "../lib/resource-limits";
import { POST } from "../app/api/chat/route";
import MockOpenAI from "./mocks/openai";

const encoder = new TextEncoder();
const user = (content: string) => ({ role: "user" as const, content });
const assistant = (content: string) => ({ role: "assistant" as const, content });

function bodyOf(result: ReturnType<typeof buildChatRequest>) {
  if (!result.ok) throw new Error(result.error);
  return result.body;
}

describe("outgoing chat history budgets", () => {
  it("exposes the runtime serialized-body cap to the browser", () => {
    vi.stubEnv("JENSEN_CHAT_BODY_BYTES", "12345");
    expect(getClientLimits().chatBodyBytes).toBe(12345);
  });

  it("keeps the newest prompt when eight valid large messages exceed the default body cap", async () => {
    const limits = getClientLimits();
    const history = Array.from({ length: 8 }, () => [user("a".repeat(limits.messageBytes)), assistant("OK")]).flat();
    const newest = user("Short follow-up");
    history.push(newest);
    expect(encoder.encode(JSON.stringify({ messages: history, mode: "standard" })).byteLength).toBeGreaterThan(limits.chatBodyBytes);

    const body = bodyOf(buildChatRequest(history, "standard", limits));
    const messages = JSON.parse(body).messages;
    expect(encoder.encode(body).byteLength).toBeLessThanOrEqual(limits.chatBodyBytes);
    expect(messages.at(-1)).toEqual(newest);
    expect(messages).toEqual(history.slice(-messages.length));
    expect(history.length).toBe(17);

    vi.stubEnv("JENSEN_DEMO_MODE", "true");
    const response = await POST(new Request("http://localhost/api/chat", {
      method: "POST", headers: { "content-type": "application/json" }, body
    }));
    expect(response.status).toBe(200);
    expect(MockOpenAI).not.toHaveBeenCalled();
  });

  it.each(["user", "assistant"] as const)("drops the prefix through an oversized historical %s entry", (role) => {
    const limits = getClientLimits();
    const newest = user("Follow up");
    const history = [user("old"), { role, content: "a".repeat(limits.messageBytes + 1) }, assistant("OK"), newest];
    const body = bodyOf(buildChatRequest(history, "standard", limits));
    expect(JSON.parse(body).messages).toEqual([assistant("OK"), newest]);
    expect(history.length).toBe(4);
  });

  it("counts JSON escaping, separators, mode, and envelope bytes", () => {
    const limits = { ...getClientLimits(), chatBodyBytes: 100 };
    const newest = user('"\\\n'.repeat(4));
    const history = [user("a".repeat(30)), newest];
    const body = bodyOf(buildChatRequest(history, "unhinged", limits));
    expect(encoder.encode(body).byteLength).toBeLessThanOrEqual(100);
    expect(JSON.parse(body)).toEqual({ messages: [newest], mode: "unhinged" });
  });

  it("counts multibyte UTF-8 content and accepts the exact serialized byte boundary", () => {
    const newest = user("\u{1F600}\u{1F600}");
    const expected = JSON.stringify({ messages: [newest], mode: "standard" });
    const byteLimit = encoder.encode(expected).byteLength;
    expect(byteLimit).toBeGreaterThan(expected.length);
    const limits = { ...getClientLimits(), messageBytes: 8, chatBodyBytes: byteLimit };
    expect(bodyOf(buildChatRequest([newest], "standard", limits))).toBe(expected);
    expect(buildChatRequest([newest], "standard", { ...limits, chatBodyBytes: byteLimit - 1 })).toMatchObject({ ok: false });
  });

  it("rejects a newest prompt exceeding the message limit instead of silently truncating it", () => {
    const newest = user("12345");
    expect(buildChatRequest([user("old"), newest], "standard", { ...getClientLimits(), messageBytes: 4 })).toMatchObject({ ok: false });
    expect(newest.content).toBe("12345");
  });

  it("honors the message count cap without serializing UI-only fields", () => {
    const history = [
      user("first"),
      { ...assistant("second"), id: "ui-only" },
      { ...user("latest"), id: "also-ui-only" }
    ];
    const body = bodyOf(buildChatRequest(history, "standard", { ...getClientLimits(), maxMessages: 2 }));
    expect(JSON.parse(body).messages).toEqual([assistant("second"), user("latest")]);
    expect(body).not.toContain("ui-only");
  });

  it("reports an empty history without producing an invalid outgoing request", () => {
    expect(buildChatRequest([], "standard", getClientLimits())).toMatchObject({ ok: false });
  });
});
