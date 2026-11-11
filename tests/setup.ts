import { beforeEach, vi } from "vitest";
import { createResponse, createTranscription } from "./mocks/openai";

vi.mock("openai", () => import("./mocks/openai"));

// Fail on accidental network use, including on machines with real API keys.
beforeEach(() => {
  createResponse.mockReset();
  createTranscription.mockReset();
  vi.stubGlobal("fetch", vi.fn(() => {
    throw new Error("Network access is disabled in unit tests. Mock the provider boundary.");
  }));

  vi.stubEnv("AI_PROVIDER", "openai");
  vi.stubEnv("JENSEN_DEMO_MODE", "false");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("XAI_API_KEY", "");
  vi.stubEnv("OPENAI_MODEL", "test-chat-model");
  vi.stubEnv("XAI_MODEL", "test-xai-model");
  vi.stubEnv("OPENAI_TRANSCRIBE_MODEL", "test-transcription-model");
});
