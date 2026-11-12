import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBoundedRecording } from "../lib/recording";

class Recorder {
  static latest: Recorder;
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  onerror?: () => void;
  start = vi.fn(() => { this.state = "recording"; });
  stop = vi.fn(() => {
    this.state = "inactive";
    this.onstop?.();
  });
  constructor() { Recorder.latest = this; }
}

describe("bounded browser recording", () => {
  const trackStop = vi.fn();
  const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("MediaRecorder", Recorder);
  });
  afterEach(() => vi.useRealTimers());

  it("flushes a normal recording and releases microphone tracks and timers", () => {
    const complete = vi.fn();
    const error = vi.fn();
    const recording = startBoundedRecording(stream, {}, { audioBytes: 10, audioSeconds: 2 }, complete, error);
    Recorder.latest.ondataavailable?.({ data: new Blob(["abc"]) });
    recording.stop();
    expect(complete).toHaveBeenCalledWith(expect.any(Blob));
    expect(complete.mock.calls[0][0].size).toBe(3);
    expect(trackStop).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(Recorder.latest.start).toHaveBeenCalledWith(250);
  });

  it("automatically stops at the capture deadline", async () => {
    const complete = vi.fn();
    startBoundedRecording(stream, {}, { audioBytes: 10, audioSeconds: 2 }, complete, vi.fn());
    Recorder.latest.ondataavailable?.({ data: new Blob(["abc"]) });
    await vi.advanceTimersByTimeAsync(1500);
    expect(Recorder.latest.stop).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(trackStop).toHaveBeenCalled();
  });

  it("discards the recording if any chunk would exceed the byte cap", () => {
    const complete = vi.fn();
    const error = vi.fn();
    startBoundedRecording(stream, {}, { audioBytes: 3, audioSeconds: 2 }, complete, error);
    Recorder.latest.ondataavailable?.({ data: new Blob(["abc"]) });
    Recorder.latest.ondataavailable?.({ data: new Blob(["d"]) });
    expect(complete).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("size limit"));
    expect(trackStop).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposal stops the microphone without triggering transcription", () => {
    const complete = vi.fn();
    const recording = startBoundedRecording(stream, {}, { audioBytes: 10, audioSeconds: 2 }, complete, vi.fn());
    Recorder.latest.ondataavailable?.({ data: new Blob(["abc"]) });
    recording.dispose();
    expect(complete).not.toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases acquired microphone tracks when recorder construction fails", () => {
    vi.stubGlobal("MediaRecorder", class { constructor() { throw new Error("unsupported"); } });
    expect(() => startBoundedRecording(stream, {}, { audioBytes: 10, audioSeconds: 2 }, vi.fn(), vi.fn())).toThrow("unsupported");
    expect(trackStop).toHaveBeenCalled();
  });
});
