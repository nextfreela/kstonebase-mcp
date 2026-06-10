// HTTP/SSE transport (per Kstonebase spec "mcp-server" §3 BDD
// "HTTP+SSE transport for hosted agents" + §5 "HTTP/SSE transport").
//
// This is the hosted-agent path. The MCP SDK's StreamableHTTPServerTransport
// auto-detects whether the caller wants SSE streaming or a direct JSON
// response based on the Accept header, so a single `/mcp` endpoint covers
// both shapes — that's intentional in the modern MCP wire format.
//
// CORS defaults to deny: only same-origin requests (no Origin header) and
// origins explicitly listed via `--cors-origin` are allowed. This keeps an
// agent that picks up the local server URL out of reach for a malicious
// page that happens to be open in the user's browser.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { ResolvedConfig } from "./config.js";
import { logger } from "./logger.js";
import { buildServer } from "./server.js";

export const DEFAULT_HTTP_PORT = 7345;
export const DEFAULT_HTTP_HOST = "127.0.0.1";
const MCP_PATH = "/mcp";
const HEALTH_PATH = "/healthz";

export interface HttpServerOptions {
  config: ResolvedConfig;
  port?: number;
  host?: string;
  /**
   * Allowlisted Origin header values. Empty array (default) rejects every
   * cross-origin request. Use the literal `"*"` only for trusted internal
   * environments — the CLI logs a warning when it sees this.
   */
  corsOrigins?: string[];
}

export interface HttpServerHandle {
  close: () => Promise<void>;
  port: number;
  host: string;
}

/**
 * Start the HTTP/SSE MCP server. Resolves once the listener is bound so the
 * caller knows the actual port (useful when port=0 picks an ephemeral port
 * during tests).
 */
export async function startHttpServer(
  options: HttpServerOptions,
): Promise<HttpServerHandle> {
  const port = options.port ?? DEFAULT_HTTP_PORT;
  const host = options.host ?? DEFAULT_HTTP_HOST;
  const allowedOrigins = options.corsOrigins ?? [];

  const mcpServer = buildServer({ config: options.config });

  // Stateful mode — the transport keeps an MCP session alive across
  // multiple requests so the agent's `initialize` handshake is honoured
  // for every follow-up tool/resource call.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // CORS preflight handling — applied to every request before dispatch.
    if (!applyCors(req, res, allowedOrigins)) {
      // applyCors already wrote the rejection response.
      return;
    }
    if (method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (url === HEALTH_PATH && method === "GET") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url === MCP_PATH || url.startsWith(`${MCP_PATH}?`)) {
      try {
        await transport.handleRequest(req, res);
      } catch (err) {
        logger.error("http transport handleRequest failed", {
          err: (err as Error).message,
        });
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { code: "INTERNAL_ERROR" } }));
        }
      }
      return;
    }

    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
  });

  await mcpServer.connect(transport);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort =
        address && typeof address === "object" ? address.port : port;
      logger.info("mcp server connected", {
        transport: "http",
        host,
        port: boundPort,
        apiUrl: options.config.apiUrl,
        apiUrlSource: options.config.apiUrlSource,
        productId: options.config.productId ?? undefined,
        corsOrigins: allowedOrigins,
      });
      if (allowedOrigins.includes("*")) {
        logger.warn("CORS origin '*' is permissive — restrict for production");
      }
      resolve({
        port: boundPort,
        host,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────
// CORS
// ──────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the request is permitted to proceed. Writes the 403
 * response itself when the origin is rejected so the caller can early-exit.
 *
 * Exported for unit tests so the policy can be evaluated without standing
 * up an actual HTTP server.
 */
export function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: string[],
): boolean {
  const origin = req.headers.origin;

  // Same-origin / non-browser request: no Origin header at all. Always
  // allowed — the browser only attaches Origin to cross-origin fetches.
  if (!origin) return true;

  if (allowedOrigins.includes("*")) {
    res.setHeader("access-control-allow-origin", "*");
    setStandardCorsHeaders(res);
    return true;
  }

  if (allowedOrigins.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
    setStandardCorsHeaders(res);
    return true;
  }

  res.statusCode = 403;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      error: {
        code: "CORS_ORIGIN_NOT_ALLOWED",
        message: `Origin "${origin}" is not in the CORS allowlist.`,
      },
    }),
  );
  return false;
}

function setStandardCorsHeaders(res: ServerResponse): void {
  res.setHeader(
    "access-control-allow-methods",
    "GET, POST, OPTIONS",
  );
  res.setHeader(
    "access-control-allow-headers",
    "authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id",
  );
  res.setHeader(
    "access-control-expose-headers",
    "mcp-session-id, etag",
  );
}
