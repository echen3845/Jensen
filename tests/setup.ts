import { afterEach, beforeEach, vi } from "vitest";
import { createResponse, createTranscription } from "./mocks/openai";

vi.mock("openai", () => import("./mocks/openai"));
vi.mock("../lib/quotas", async importOriginal=>({
 ...await importOriginal<typeof import("../lib/quotas")>(),
 withUsage:vi.fn(async <T,>(_user:string,_operation:string,_amount:number,work:()=>Promise<T>)=>work()),
 throttleAnonymous:vi.fn(async()=>{})
}));
vi.mock("../lib/auth", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/auth")>(),
  requireIdentity: vi.fn(async()=>({id:"00000000-0000-4000-8000-000000000001",email:null}))
}));
vi.mock("../lib/store", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/store")>(),
  ...await import("./mocks/store")
}));

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
  for(const key of ["JENSEN_CHAT_INPUT_MICRO_USD","JENSEN_CHAT_OUTPUT_MICRO_USD","JENSEN_AUDIO_MICRO_USD_PER_SECOND"])vi.stubEnv(key,"1");
  vi.stubEnv("AI_PROVIDER", "openai");
  vi.stubEnv("JENSEN_DEMO_MODE", "false");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("XAI_API_KEY", "");
  vi.stubEnv("OPENAI_MODEL", "test-chat-model");
  vi.stubEnv("XAI_MODEL", "test-xai-model");
  vi.stubEnv("OPENAI_TRANSCRIBE_MODEL", "test-transcription-model");
});
