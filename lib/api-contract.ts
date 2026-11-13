export type ApiFailure = {
  ok: false;
  error: string;
  code: string;
  requestId: string;
  retryable: boolean;
};

export function failureMessage(error: unknown) {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "Request stopped or timed out. You can try again.";
  }
  return "Connection interrupted. Please try again.";
}
