import { describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/transcribe/route";
import MockOpenAI, { createTranscription } from "./mocks/openai";
import { wavFile } from "./fixtures/audio";

function recordingRequest(audio?: File | string) {
  const formData = new FormData();
  if (audio !== undefined) formData.append("audio", audio);
  return new Request("http://localhost/api/transcribe", { method: "POST", body: formData });
}

describe("transcription provider boundary", () => {
  it("does not invoke a provider when the API key is missing", async () => {
    const response = await POST(recordingRequest(wavFile()));

    expect(await response.json()).toMatchObject({
      text: "",
      error: expect.stringContaining("not configured")
    });
    expect(MockOpenAI).not.toHaveBeenCalled();
  });

  it.each([undefined, "not a file"])("rejects absent or non-file audio (%s) before provider use", async (audio) => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");

    const response = await POST(recordingRequest(audio));

    expect(await response.json()).toMatchObject({
      text: "",
      error: expect.stringContaining("No audio file")
    });
    expect(MockOpenAI).not.toHaveBeenCalled();
  });

  it("passes the uploaded file and configured model to the mocked transcriber", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    createTranscription.mockResolvedValueOnce({ text: "Plan tomorrow" });
    const audio = wavFile();

    const response = await POST(recordingRequest(audio));

    expect(await response.json()).toEqual({ text: "Plan tomorrow" });
    expect(createTranscription).toHaveBeenCalledWith({
      model: "test-transcription-model",
      file: expect.any(File)
    }, expect.objectContaining({ signal: expect.any(AbortSignal), timeout: 30_000, maxRetries: 0 }));
    const uploaded = (createTranscription.mock.calls[0][0] as { file: File }).file;
    expect(await uploaded.arrayBuffer()).toEqual(await audio.arrayBuffer());
    expect(uploaded.name).toBe("recording.wav");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a recoverable error without exposing provider exception details", async () => {
    vi.stubEnv("OPENAI_API_KEY", "private-test-key");
    createTranscription.mockRejectedValueOnce(new Error("private-test-key internal detail"));

    const response = await POST(recordingRequest(wavFile()));
    const body = await response.json();

    expect(body.text).toBe("");
    expect(body.error).toContain("could not transcribe");
    expect(JSON.stringify(body)).not.toContain("private-test-key");
    expect(JSON.stringify(body)).not.toContain("internal detail");
  });
});
