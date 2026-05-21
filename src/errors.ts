// MCP-side error mapping (per Xpec spec "mcp-server" §5 "Error mapping").
// Translates Xpec API error envelopes into MCP error codes the
// agent can reason about, each carrying a short remediation string.

export type McpStructuredCode =
  | "AUTH_FAILED"
  | "TOKEN_EXPIRED"
  | "TOKEN_REVOKED"
  | "TOKEN_SCOPE_MISMATCH"
  | "TOKEN_SCOPE_INSUFFICIENT"
  | "PRODUCT_NOT_BOUND"
  | "WORKSPACE_NOT_BOUND"
  | "WORKSPACE_SCOPE_REQUIRED"
  | "PRODUCT_TYPE_MISMATCH"
  | "PRODUCT_TYPE_UNSUPPORTED"
  | "NOT_IN_WORKSPACE"
  | "LEGACY_BINDING_DETECTED"
  | "SPEC_LOCKED"
  | "OPEN_QUESTIONS_PRESENT"
  | "STALE_VERSION"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "INTERNAL_ERROR";

export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export interface McpFailure {
  code: McpStructuredCode;
  message: string;
  remediation: string;
}

export class McpToolError extends Error {
  constructor(
    public readonly code: McpStructuredCode,
    message: string,
    public readonly remediation: string,
  ) {
    super(message);
    this.name = "McpToolError";
  }

  toFailure(): McpFailure {
    return {
      code: this.code,
      message: this.message,
      remediation: this.remediation,
    };
  }
}

const REMEDIATIONS: Record<McpStructuredCode, string> = {
  AUTH_FAILED:
    "Regenerate a Personal Access Token from /settings/developer and update XPEC_API_TOKEN.",
  TOKEN_EXPIRED:
    "The token expired. Generate a new one from /settings/developer.",
  TOKEN_REVOKED:
    "The token was revoked. Generate a new one from /settings/developer.",
  TOKEN_SCOPE_MISMATCH:
    "The token isn't scoped to this product. Use a token whose allowlist includes it, or remove the allowlist.",
  TOKEN_SCOPE_INSUFFICIENT:
    "The token is missing the `write` scope. Regenerate it from /settings/developer with write access.",
  PRODUCT_NOT_BOUND:
    "Call list_products, pick one, then add it to .xpec.json or set XPEC_PRODUCT_ID.",
  WORKSPACE_NOT_BOUND:
    "Call list_workspaces, pick one, then add it to .xpec.json as `workspaceId` or set XPEC_WORKSPACE_ID.",
  WORKSPACE_SCOPE_REQUIRED:
    "Re-bind this credential at the Workspace level (workspaceId in .xpec.json, no product allowlist) so it can create Products in the Workspace.",
  PRODUCT_TYPE_MISMATCH:
    "The filter you passed isn't compatible with this product's type. Drop the filter or call against a matching product.",
  PRODUCT_TYPE_UNSUPPORTED:
    'This tool only supports specificationManagementType="free" in v1. Omit the field or pass "free" explicitly.',
  NOT_IN_WORKSPACE:
    "This tool requires a Workspace binding. Set `workspaceId` in .xpec.json or pass it explicitly.",
  LEGACY_BINDING_DETECTED:
    'Edit .xpec.json: rename the "workspaceId" field to "productId" (the value points at a Product under the new model). To bind to a Workspace, create one and set both ids.',
  SPEC_LOCKED:
    "The spec is in REVIEWED state. Call start_new_version first to enter Draft.",
  OPEN_QUESTIONS_PRESENT:
    "Resolve or dismiss the open questions on this spec before proceeding.",
  STALE_VERSION:
    "Re-read the spec to pick up the current OCC version, then retry with that version.",
  RATE_LIMITED:
    "You hit the per-token rate limit. Wait until the Retry-After window passes and try again.",
  NOT_FOUND:
    "The resource doesn't exist or isn't visible to this token.",
  VALIDATION_ERROR:
    "Inspect the details — at least one argument failed schema validation.",
  INTERNAL_ERROR:
    "The Xpec API hit an unexpected error. Retry once; if it persists, contact support.",
};

/**
 * Map an HTTP response (status + parsed body) onto an `McpToolError`. The
 * body's `error.code` takes precedence when present, falling back to the
 * status code's standard meaning.
 */
export function mapApiError(
  status: number,
  body: ApiErrorBody | null,
): McpToolError {
  const apiCode = body?.error?.code;
  const apiMessage =
    body?.error?.message ?? `Request failed with status ${status}.`;
  const code = pickStructuredCode(status, apiCode, body?.error?.details);
  return new McpToolError(code, apiMessage, REMEDIATIONS[code]);
}

function pickStructuredCode(
  status: number,
  apiCode: string | undefined,
  details: unknown,
): McpStructuredCode {
  // Prefer explicit codes on the API error envelope or in `details.code`.
  const explicitCode = apiCode ?? extractDetailCode(details);
  if (explicitCode) {
    if (explicitCode === "TOKEN_SCOPE_MISMATCH") return "TOKEN_SCOPE_MISMATCH";
    if (explicitCode === "TOKEN_SCOPE_INSUFFICIENT")
      return "TOKEN_SCOPE_INSUFFICIENT";
    if (explicitCode === "TOKEN_EXPIRED") return "TOKEN_EXPIRED";
    if (explicitCode === "TOKEN_REVOKED") return "TOKEN_REVOKED";
    if (explicitCode === "WORKSPACE_SCOPE_REQUIRED")
      return "WORKSPACE_SCOPE_REQUIRED";
    if (explicitCode === "PRODUCT_TYPE_MISMATCH")
      return "PRODUCT_TYPE_MISMATCH";
    if (explicitCode === "PRODUCT_TYPE_UNSUPPORTED")
      return "PRODUCT_TYPE_UNSUPPORTED";
    if (explicitCode === "NOT_IN_WORKSPACE") return "NOT_IN_WORKSPACE";
    if (explicitCode === "SPEC_LOCKED") return "SPEC_LOCKED";
    if (explicitCode === "OPEN_QUESTIONS_PRESENT")
      return "OPEN_QUESTIONS_PRESENT";
    if (explicitCode === "STALE_VERSION") return "STALE_VERSION";
    if (explicitCode === "AUTH_REQUIRED" || explicitCode === "AUTH_FAILED")
      return "AUTH_FAILED";
  }

  // Fallback by status code.
  if (status === 401) return "AUTH_FAILED";
  if (status === 403) return "TOKEN_SCOPE_MISMATCH";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "STALE_VERSION";
  if (status === 422) return "VALIDATION_ERROR";
  if (status === 429) return "RATE_LIMITED";
  return "INTERNAL_ERROR";
}

function extractDetailCode(details: unknown): string | undefined {
  if (
    details &&
    typeof details === "object" &&
    "code" in details &&
    typeof (details as { code: unknown }).code === "string"
  ) {
    return (details as { code: string }).code;
  }
  return undefined;
}

export function buildClientFailure(code: McpStructuredCode, message: string): McpFailure {
  return { code, message, remediation: REMEDIATIONS[code] };
}
