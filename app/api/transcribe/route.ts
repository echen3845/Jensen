import { apiRoute, ApiError } from "../../../lib/api-errors";
import OpenAI from "openai";
import { requireIdentity, localDemo } from "../../../lib/auth";
import { NextResponse } from "next/server";
import { validateAudio } from "../../../lib/audio-validation";
import { getResourceLimits } from "../../../lib/resource-limits";
import { readLimitedBody, RequestError, withDeadline } from "../../../lib/request-resources";

export async function POST(request: Request) {
  return apiRoute(request, "transcribe", handleTranscription);
}

async function handleTranscription(request: Request) {
  if (localDemo()) throw new ApiError(403,"demo_read_only","Demo mode does not send recordings to paid providers.");
  await requireIdentity(request);
  const limits = getResourceLimits();
  const apiKey = process.env.OPENAI_API_KEY;
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
      throw new ApiError(503, "provider_configuration", "The transcription provider is not configured.");
    }
    return NextResponse.json({ text: transcription.text || "" });
}
