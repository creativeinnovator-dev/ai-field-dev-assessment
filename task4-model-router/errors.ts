// All errors go out to the client in the same shape:
//   { error: { type, message, request_id } }
// The real reason (upstream body, stack trace...) only goes to the logs.

export type GatewayErrorType =
  | "authentication_error"
  | "invalid_request_error"
  | "rate_limit_exceeded"
  | "request_too_large"
  | "upstream_unavailable"
  | "upstream_timeout"
  | "internal_error";

const PUBLIC_MESSAGES: Record<GatewayErrorType, string> = {
  authentication_error: "Invalid or missing API key.",
  invalid_request_error: "The request was invalid.",
  rate_limit_exceeded: "Token rate limit exceeded. Retry after the indicated delay.",
  request_too_large: "The request exceeds the per-minute token limit for this API key.",
  upstream_unavailable: "All model providers are currently unavailable. Please retry.",
  upstream_timeout: "The model providers did not respond in time. Please retry.",
  internal_error: "An internal error occurred.",
};

const STATUS: Record<GatewayErrorType, number> = {
  authentication_error: 401,
  invalid_request_error: 400,
  rate_limit_exceeded: 429,
  request_too_large: 413,
  upstream_unavailable: 503,
  upstream_timeout: 504,
  internal_error: 500,
};

export class GatewayError extends Error {
  readonly type: GatewayErrorType;
  readonly status: number;
  readonly publicMessage: string;
  readonly detail?: string; // for logs only
  readonly retryAfterMs?: number;

  constructor(type: GatewayErrorType, opts: { publicMessage?: string; detail?: string; retryAfterMs?: number } = {}) {
    super(opts.detail ?? type);
    this.type = type;
    this.status = STATUS[type];
    this.publicMessage = opts.publicMessage ?? PUBLIC_MESSAGES[type];
    this.detail = opts.detail;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

// anything we didn't throw ourselves becomes a generic internal_error
export function toGatewayError(err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;
  return new GatewayError("internal_error", { detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
}

export function errorPayload(err: GatewayError, requestId: string) {
  return { error: { type: err.type, message: err.publicMessage, request_id: requestId } };
}
