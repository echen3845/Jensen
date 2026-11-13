import { BufferSource, Input, MP4, WAVE, WEBM } from "mediabunny";
import type { ResourceLimits } from "./resource-limits";
import { RequestError } from "./request-resources";

const mimeTypes = new Map([
  ["audio/webm", WEBM],
  ["audio/mp4", MP4],
  ["audio/x-m4a", MP4],
  ["audio/wav", WAVE],
  ["audio/x-wav", WAVE]
]);

// Parse only in-memory, explicitly allowed containers; never follow external URLs.
export async function validateAudio(file: File, limits: ResourceLimits, signal: AbortSignal) {
  if (file.size === 0) throw new RequestError(400, "empty_audio", "The recording is empty.");
  if (file.size > limits.audioBytes) {
    throw new RequestError(413, "audio_too_large", "Recording exceeds the byte limit.");
  }
  const declared = file.type.split(";")[0].trim().toLowerCase();
  const format = mimeTypes.get(declared);
  if (!format) throw new RequestError(415, "unsupported_audio", "Use WebM, MP4/M4A, or WAV audio.");
  const bytes = await file.arrayBuffer();
  if (signal.aborted) throw signal.reason;
  const input = new Input({ source: new BufferSource(bytes), formats: [WEBM, MP4, WAVE] });
  const cancel = () => input.dispose();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (await input.getFormat() !== format) {
      throw new RequestError(415, "audio_type_mismatch", "Audio content does not match its declared type.");
    }
    const audioTracks = await input.getAudioTracks();
    if (audioTracks.length !== 1 || (await input.getVideoTracks()).length > 0) {
      throw new RequestError(415, "unsupported_tracks", "Upload a recording with one audio track and no video.");
    }
    // skipLiveWait handles MediaRecorder's finalized WebM without a duration header.
    const end = await input.computeDuration(undefined, { skipLiveWait: true });
    const start = await input.getFirstTimestamp();
    const duration = end - Math.min(0, start);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new RequestError(415, "invalid_audio", "The recording has no readable audio duration.");
    }
    if (duration > limits.audioSeconds) {
      throw new RequestError(413, "audio_too_long", "Recording exceeds the duration limit.");
    }
    if (signal.aborted) throw signal.reason;
    const extension = format === WEBM ? "webm" : format === MP4 ? "m4a" : "wav";
    return new File([bytes], `recording.${extension}`, {
      type: format === WEBM ? "audio/webm" : format === MP4 ? "audio/mp4" : "audio/wav"
    });
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (signal.aborted) throw signal.reason;
    throw new RequestError(415, "invalid_audio", "The recording is corrupt or unsupported.");
  } finally {
    signal.removeEventListener("abort", cancel);
    input.dispose();
  }
}
