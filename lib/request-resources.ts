import { NextResponse } from "next/server";

export class RequestError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "RequestError";
  }
}

export function resourceError(error: unknown) {
  if (!(error instanceof RequestError)) return null;
  return NextResponse.json({ error: error.message, code: error.code, text: "" }, { status: error.status });
}

export async function withDeadline<T>(
  parent: AbortSignal,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
  timeoutStatus = 504
): Promise<T> {
  if (parent.aborted) throw new RequestError(499, "request_cancelled", "Request cancelled.");
  const controller = new AbortController();
  let rejectAbort: (reason: RequestError) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = (reason: RequestError) => {
    controller.abort(reason);
    rejectAbort(reason);
  };
  const onCancel = () => abort(new RequestError(499, "request_cancelled", "Request cancelled."));
  parent.addEventListener("abort", onCancel, { once: true });
  const timer = setTimeout(() => abort(new RequestError(
    timeoutStatus, "request_timeout", timeoutStatus === 408 ? "Request body took too long." : "Processing deadline exceeded. Try again."
  )), timeoutMs);
  try {
    return await Promise.race([aborted, Promise.resolve().then(() => work(controller.signal))]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", onCancel);
  }
}

// Check the stream itself, not just the optional and untrusted Content-Length.
export async function readLimitedBody(request: Request, maxBytes: number, signal: AbortSignal) {
  const encoding = request.headers.get("content-encoding");
  if (encoding && encoding !== "identity") {
    void request.body?.cancel().catch(() => {});
    throw new RequestError(415, "unsupported_encoding", "Compressed request bodies are not supported.");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    void request.body?.cancel().catch(() => {});
    throw new RequestError(413, "body_too_large", "Request body exceeds the byte limit.");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw new RequestError(499, "request_cancelled", "Request cancelled.");
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        cancel();
        throw new RequestError(413, "body_too_large", "Request body exceeds the byte limit.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export async function readLimitedJson(request: Request, maxBytes: number, timeoutMs: number): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    void request.body?.cancel().catch(() => {});
    throw new RequestError(415, "unsupported_media_type", "Use application/json for chat requests.");
  }
  const bytes = await withDeadline(request.signal, timeoutMs, (signal) => readLimitedBody(request, maxBytes, signal), 408);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RequestError(400, "invalid_json", "Invalid JSON body.");
  }
}
