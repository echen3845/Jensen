// Server-side configuration. Only ClientLimits values are serialized to the browser.
export type ClientLimits = {
  maxMessages: number;
  messageBytes: number;
  audioBytes: number;
  audioSeconds: number;
  requestTimeoutMs: number;
};

function setting(name: string, fallback: number, ceiling: number, minimum = 1) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= ceiling ? value : fallback;
}

export function getResourceLimits() {
  return {
    chatBodyBytes: setting("JENSEN_CHAT_BODY_BYTES", 65_536, 1_048_576),
    maxMessages: setting("JENSEN_MAX_MESSAGES", 32, 128),
    messageBytes: setting("JENSEN_MESSAGE_BYTES", 8_192, 65_536),
    inputBytes: setting("JENSEN_MODEL_INPUT_BYTES", 24_000, 131_072),
    outputTokens: setting("JENSEN_MODEL_OUTPUT_TOKENS", 1_024, 8_192),
    audioBytes: setting("JENSEN_AUDIO_BYTES", 4_194_304, 16_777_216),
    audioSeconds: setting("JENSEN_AUDIO_SECONDS", 60, 300),
    bodyTimeoutMs: setting("JENSEN_BODY_TIMEOUT_MS", 15_000, 60_000),
    providerTimeoutMs: setting("JENSEN_PROVIDER_TIMEOUT_MS", 30_000, 120_000),
    providerRetries: setting("JENSEN_PROVIDER_RETRIES", 0, 2, 0)
  };
}

export type ResourceLimits = ReturnType<typeof getResourceLimits>;

export function getClientLimits(): ClientLimits {
  const { maxMessages, messageBytes, audioBytes, audioSeconds, bodyTimeoutMs, providerTimeoutMs } = getResourceLimits();
  return { maxMessages, messageBytes, audioBytes, audioSeconds, requestTimeoutMs: bodyTimeoutMs + providerTimeoutMs + 2000 };
}
