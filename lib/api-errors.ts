import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

export class ApiError extends Error {
  constructor(
    public status: number, public code: string, message: string,
    public retryAfter?: number
  ) { super(message); this.name = "ApiError"; }
}

export function classifyError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  if (value.name === "APIConnectionTimeoutError" || value.name === "TimeoutError") {
    return new ApiError(504, "provider_timeout", "The provider timed out. Please try again.");
  }
  if (value.name === "APIUserAbortError" || value.name === "AbortError") {
    return new ApiError(499, "request_cancelled", "Request cancelled.");
  }
  const nested = value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : {};
  const code = value.code || nested.code;
  if (code === "insufficient_quota" || code === "billing_hard_limit_reached" || code === "billing_not_active") {
    return new ApiError(503, "provider_billing", "Provider billing or credits are unavailable.");
  }
  if (value.status === 429) {
    const header = (value.headers as Headers | undefined)?.get?.("retry-after");
    const wait = Number(header);
    return new ApiError(429, "provider_rate_limited", "The provider is busy. Try again shortly.",
      Number.isInteger(wait) && wait > 0 ? Math.min(wait, 60) : 10);
  }
  if (value.status === 401 || value.status === 403) {
    return new ApiError(503, "provider_configuration", "The provider credentials or permissions need attention.");
  }
  if (typeof value.status === "number" || value.name === "APIConnectionError") {
    return new ApiError(502, "provider_unavailable", "The provider could not complete this request. Please try again.");
  }
  return new ApiError(500, "internal_error", "Unable to complete this request.");
}

export async function apiRoute(
  request: Request, operation: string, handle: (request: Request) => Promise<Response>
) {
  const requestId = randomUUID();
  const started = Date.now();
  let status = 500;
  let code = "internal_error";
  try {
    const response = await handle(request);
    if (response.status >= 300 && response.status < 400) {
      status=response.status; code="redirect";
      response.headers.set("x-request-id",requestId);
      response.headers.set("cache-control","no-store");
      return response;
    }
    const body = await response.json();
    if (!response.ok) throw new ApiError(response.status, body.code || "invalid_request", body.error || "Request failed.");
    status = response.status;
    code = "ok";
    return NextResponse.json({ ...body, ok: true, requestId }, {
      status, headers: new Headers([...response.headers, ["x-request-id",requestId], ["cache-control","no-store"]])
    });
  } catch (error) {
    const failure = classifyError(error);
    status = failure.status;
    code = failure.code;
    const retryable = failure.retryAfter !== undefined || status === 502 || status === 504;
    return NextResponse.json({
      ok: false, error: failure.message, code, requestId, retryable, text: ""
    }, { status, headers: {
      "x-request-id": requestId, "cache-control": "no-store",
      ...(failure.retryAfter ? { "retry-after": String(failure.retryAfter) } : {})
    } });
  } finally {
    // Fixed fields only: never serialize provider exceptions, headers, bodies or credentials.
    console.info(JSON.stringify({ event: "api_request", operation, requestId, status, code, durationMs: Date.now() - started }));
  }
}
