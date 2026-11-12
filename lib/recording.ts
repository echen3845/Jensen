import type { ClientLimits } from "./resource-limits";

export function startBoundedRecording(
  stream: MediaStream,
  options: MediaRecorderOptions,
  limits: Pick<ClientLimits, "audioBytes" | "audioSeconds">,
  onComplete: (audio: Blob) => void,
  onError: (message: string) => void
) {
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, options);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
  let chunks: Blob[] = [];
  let bytes = 0;
  let discarded = false;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    clearTimeout(timer);
    stream.getTracks().forEach((track) => track.stop());
  };
  const stop = () => {
    if (recorder.state !== "inactive") recorder.stop();
  };
  const discard = (message?: string) => {
    if (finished) return;
    discarded = true;
    chunks = [];
    stop();
    release();
    if (message) onError(message);
  };
  recorder.ondataavailable = (event) => {
    if (discarded || finished || event.data.size === 0) return;
    if (bytes + event.data.size > limits.audioBytes) {
      discard("Recording reached its size limit. Try a shorter recording.");
      return;
    }
    bytes += event.data.size;
    chunks.push(event.data);
  };
  recorder.onerror = () => discard("Recording failed. Please try again.");
  recorder.onstop = () => {
    if (finished) return;
    finished = true;
    release();
    const audio = new Blob(chunks, { type: recorder.mimeType });
    chunks = [];
    if (discarded) return;
    if (audio.size === 0) onError("No audio was recorded.");
    else onComplete(audio);
  };
  try {
    // Request small chunks so retained data is checked throughout capture.
    recorder.start(250);
    // Leave room for the last chunk when the browser flushes on stop.
    timer = setTimeout(stop, Math.max(1, limits.audioSeconds * 1000 - 500));
  } catch (error) {
    discarded = true;
    release();
    throw error;
  }
  return { stop, dispose: () => discard() };
}
