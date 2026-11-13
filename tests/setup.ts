import { afterEach, beforeEach, vi } from "vitest";
import { createResponse, createTranscription } from "./mocks/openai";

vi.mock("openai", () => import("./mocks/openai"));

// Fail on accidental network use, including on machines with real API keys.
afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  createResponse.mockReset();
  createTranscription.mockReset();
  vi.stubGlobal("fetch", vi.fn(() => {
    throw new Error("Network access is disabled in unit tests. Mock the provider boundary.");
  }));

  for (const key of [
    "JENSEN_CHAT_BODY_BYTES", "JENSEN_MAX_MESSAGES", "JENSEN_MESSAGE_BYTES",
    "JENSEN_MODEL_INPUT_BYTES", "JENSEN_MODEL_OUTPUT_TOKENS", "JENSEN_AUDIO_BYTES",
    "JENSEN_AUDIO_SECONDS", "JENSEN_BODY_TIMEOUT_MS", "JENSEN_PROVIDER_TIMEOUT_MS",
    "JENSEN_PROVIDER_RETRIES"
  ]) vi.stubEnv(key, "");
  vi.stubEnv("AI_PROVIDER", "openai");
  vi.stubEnv("JENSEN_DEMO_MODE", "false");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("XAI_API_KEY", "");
  vi.stubEnv("OPENAI_MODEL", "test-chat-model");
  vi.stubEnv("XAI_MODEL", "test-xai-model");
  vi.stubEnv("OPENAI_TRANSCRIBE_MODEL", "test-transcription-model");
});
