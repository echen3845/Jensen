import { vi } from "vitest";

export const createResponse = vi.fn<(...args: unknown[]) => Promise<{ output_text: string }>>();
export const createTranscription = vi.fn<(...args: unknown[]) => Promise<{ text: string }>>();

export default vi.fn(class MockOpenAI {
  responses = { create: createResponse };
  audio = { transcriptions: { create: createTranscription } };
});
