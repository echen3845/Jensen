import { describe, expect, it, vi } from "vitest";
import {
  BufferTarget, EncodedAudioPacketSource, EncodedPacket,
  Mp4OutputFormat, Output, WebMOutputFormat
} from "mediabunny";
import { POST } from "../app/api/transcribe/route";
import { createTranscription } from "./mocks/openai";
import { wavFile } from "./fixtures/audio";

async function encodedFile(kind: "webm" | "streaming-webm" | "mp4", endTimestamp = 0.02) {
  const target = new BufferTarget();
  const webm = kind !== "mp4";
  const source = new EncodedAudioPacketSource(webm ? "opus" : "aac");
  const output = new Output({
    target,
    format: webm ? new WebMOutputFormat({ appendOnly: kind === "streaming-webm" }) : new Mp4OutputFormat()
  });
  output.addAudioTrack(source);
  await output.start();
  await source.add(new EncodedPacket(
    // Opus DTX frame, or an AAC packet fixture; demuxing does not decode samples.
    new Uint8Array(webm ? [0xf8, 0xff, 0xfe] : [0x01, 0x40, 0x22, 0x80, 0xa3, 0x4e]),
    "key", endTimestamp - 0.02, 0.02
  ), { decoderConfig: {
    codec: webm ? "opus" : "mp4a.40.2",
    sampleRate: 48000, numberOfChannels: 1,
    ...(webm ? {} : { description: new Uint8Array([0x11, 0x88]) })
  } });
  await output.finalize();
  if (!target.buffer) throw new Error("No fixture output");
  return new File([target.buffer], webm ? "voice.webm" : "voice.m4a", {
    type: webm ? "audio/webm;codecs=opus" : "audio/mp4"
  });
}

async function transcribe(file: File) {
  const body = new FormData();
  body.append("audio", file);
  return POST(new Request("http://localhost/api/transcribe", { method: "POST", body }));
}

describe("audio container validation with real demuxing", () => {
  it.each(["webm", "streaming-webm", "mp4"] as const)("accepts %s containers with one audio track", async (kind) => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    createTranscription.mockResolvedValueOnce({ text: "hello" });
    const response = await transcribe(await encodedFile(kind));
    expect(await response.json()).toMatchObject({ text: "hello" });
    expect(response.status).toBe(200);
  });

  it("bounds a streaming WebM using packet timestamps without a duration header", async () => {
    vi.stubEnv("JENSEN_AUDIO_SECONDS", "1");
    const response = await transcribe(await encodedFile("streaming-webm", 5));
    expect(response.status).toBe(413);
    expect(createTranscription).not.toHaveBeenCalled();
  });

  it("rejects truncated audio rather than trusting its filename and header", async () => {
    const header = (await wavFile().arrayBuffer()).slice(0, 44);
    const response = await transcribe(new File([header], "voice.wav", { type: "audio/wav" }));
    expect(response.status).toBe(415);
    expect(createTranscription).not.toHaveBeenCalled();
  });
});
