import OpenAI from "openai";
import { NextResponse } from "next/server";
import { validateAudio } from "../../../lib/audio-validation";
import { getResourceLimits } from "../../../lib/resource-limits";
import { readLimitedBody, RequestError, resourceError, withDeadline } from "../../../lib/request-resources";

export async function POST(request: Request) {
  const limits = getResourceLimits();
  const apiKey = process.env.OPENAI_API_KEY;
  try {
    const type = request.headers.get("content-type") || "";
    if (!/^multipart\/form-data\s*;/i.test(type)) {
      void request.body?.cancel().catch(() => {});
      throw new RequestError(415, "unsupported_media_type", "Use multipart/form-data for recordings.");
    }
    // Allow a small, bounded multipart envelope in addition to the file bytes.
    const bytes = await withDeadline(request.signal, limits.bodyTimeoutMs,
      (signal) => readLimitedBody(request, limits.audioBytes + 16_384, signal), 408);
    let formData: FormData;
    try {
      formData = await new Response(bytes, { headers: { "content-type": type } }).formData();
    } catch {
      throw new RequestError(400, "invalid_form", "Invalid multipart recording upload.");
    }
    const entries = [...formData.entries()];
    const audio = formData.get("audio");
    if (!(audio instanceof File)) {
      throw new RequestError(400, "missing_audio", "No audio file was received.");
    }
    if (entries.length !== 1) {
      throw new RequestError(400, "invalid_form", "Upload exactly one audio file.");
    }
    const transcription = await withDeadline(request.signal, limits.providerTimeoutMs, async (signal) => {
      const file = await validateAudio(audio, limits, signal);
      if (!apiKey) return null;
      const client = new OpenAI({
        apiKey, timeout: limits.providerTimeoutMs, maxRetries: limits.providerRetries
      });
      return client.audio.transcriptions.create({
        file,
        model: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe"
      }, { signal, timeout: limits.providerTimeoutMs, maxRetries: limits.providerRetries });
    });
    if (!transcription) {
      return NextResponse.json({ text: "", error: "OpenAI API key is not configured." }, { status: 503 });
    }
    return NextResponse.json({ text: transcription.text || "" });
  } catch (error) {
    const bounded = resourceError(error);
    if (bounded) return bounded;
    if (error instanceof Error && error.name === "APIConnectionTimeoutError") {
      return NextResponse.json({ text: "", error: "Transcription deadline exceeded.", code: "request_timeout" }, { status: 504 });
    }
    return NextResponse.json({
      text: "",
      error: "I could not transcribe the microphone recording. Check API credits, microphone permission, and network access."
    }, { status: 502 });
  }
}
