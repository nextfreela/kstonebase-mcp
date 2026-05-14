// Resource provider for the MCP server. Phase 4 doubles the surface so
// agents can address either a Product or a Workspace via stable URIs:
//
//   xpec://product/{productId}                  — collection: lists Product specs
//   xpec://product/{productId}/spec/{specId}    — Product spec Markdown body
//   xpec://workspace/{workspaceId}              — collection: lists Workspace specs
//   xpec://workspace/{workspaceId}/spec/{specId} — Workspace spec Markdown body
//
// Collection URIs are registered as fixed resources so the agent can
// list-then-pin. Individual specs are exposed via ResourceTemplates so the
// agent can read any spec in the bound scope by id. ETag/304 behavior is
// unchanged (per mcp-workspace-tools.md §3).

import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { XpecClient } from "./client.js";
import type { ResolvedConfig } from "./config.js";
import { McpToolError } from "./errors.js";
import { logger } from "./logger.js";

interface ResourceDeps {
  client: XpecClient;
  config: ResolvedConfig;
}

interface ResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

export function registerResources(
  server: McpServer,
  deps: ResourceDeps,
): void {
  const { client, config } = deps;

  if (!config.productId && !config.workspaceId) {
    // Discovery mode — no bound scope means no resource surface. The agent
    // can call list_products / list_workspaces to discover ids; resources
    // become available after the user binds a scope and reconnects.
    logger.debug("resources skipped — no binding (discovery mode)");
    return;
  }

  if (config.workspaceId) {
    registerWorkspaceResources(server, client, config.workspaceId);
  }
  if (config.productId) {
    registerProductResources(server, client, config.productId);
  }
}

function registerProductResources(
  server: McpServer,
  client: XpecClient,
  productId: string,
): void {
  const wsId = productId;
  const collectionUri = `xpec://product/${wsId}`;

  server.registerResource(
    "product-specs",
    collectionUri,
    {
      title: "Product specifications",
      description: `Specifications in product ${wsId}. Read this resource to enumerate the specs an agent can pin into context.`,
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const res = await client.listSpecifications(wsId, { limit: 100 });
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "application/json",
              text: JSON.stringify(res.body, null, 2),
            } satisfies ResourceContent,
          ],
        };
      } catch (err) {
        throw mapResourceError(err);
      }
    },
  );

  // Per-spec template — the agent reads a Markdown body by spec id.
  // The template's `{specId}` slot maps onto a string variable.
  const template = new ResourceTemplate(
    `xpec://product/${wsId}/spec/{specId}`,
    {
      list: undefined,
    },
  );

  server.registerResource(
    "specification-body",
    template,
    {
      title: "Specification Markdown",
      description:
        "Read the current Markdown body of a specification. The resource etag mirrors the spec's optimistic-concurrency version, so the client can re-read after change notifications without comparing content.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const specId = String(variables.specId ?? "");
      if (!specId) {
        throw new McpToolError(
          "VALIDATION_ERROR",
          "Resource URI is missing a specId.",
          "Use the URI shape xpec://product/{productId}/spec/{specId}.",
        );
      }
      try {
        const res = await client.readSpecification(specId, { format: "raw" });
        if ("notModified" in res) {
          // Tool reads don't carry If-None-Match, so 304 should not occur.
          return {
            contents: [
              {
                uri: uri.toString(),
                mimeType: "text/markdown",
                text: "",
              } satisfies ResourceContent,
            ],
          };
        }
        const body = res.body as { content?: string; etag?: string } | null;
        const text = typeof body?.content === "string" ? body.content : "";
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "text/markdown",
              text,
            } satisfies ResourceContent,
          ],
          // SDK passes through `_meta` on the resource result; the etag is
          // surfaced for clients that want to short-circuit re-reads.
          _meta: {
            etag: res.etag ?? body?.etag ?? null,
          },
        };
      } catch (err) {
        throw mapResourceError(err);
      }
    },
  );
}

function registerWorkspaceResources(
  server: McpServer,
  client: XpecClient,
  workspaceId: string,
): void {
  const collectionUri = `xpec://workspace/${workspaceId}`;

  server.registerResource(
    "workspace-specs",
    collectionUri,
    {
      title: "Workspace specifications",
      description: `Specifications in workspace ${workspaceId}. Read this resource to enumerate the cross-product specs an agent can pin into context.`,
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const res = await client.listSpecificationsForWorkspace(workspaceId, {
          limit: 100,
        });
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "application/json",
              text: JSON.stringify(res.body, null, 2),
            } satisfies ResourceContent,
          ],
        };
      } catch (err) {
        throw mapResourceError(err);
      }
    },
  );

  const template = new ResourceTemplate(
    `xpec://workspace/${workspaceId}/spec/{specId}`,
    {
      list: undefined,
    },
  );

  server.registerResource(
    "workspace-specification-body",
    template,
    {
      title: "Workspace specification Markdown",
      description:
        "Read the current Markdown body of a workspace-scoped specification. Etag mirrors the spec's OCC version (Phase 4 mcp-workspace-tools.md §3).",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const specId = String(variables.specId ?? "");
      if (!specId) {
        throw new McpToolError(
          "VALIDATION_ERROR",
          "Resource URI is missing a specId.",
          "Use the URI shape xpec://workspace/{workspaceId}/spec/{specId}.",
        );
      }
      try {
        const res = await client.readSpecification(specId, { format: "raw" });
        if ("notModified" in res) {
          return {
            contents: [
              {
                uri: uri.toString(),
                mimeType: "text/markdown",
                text: "",
              } satisfies ResourceContent,
            ],
          };
        }
        const body = res.body as { content?: string; etag?: string } | null;
        const text = typeof body?.content === "string" ? body.content : "";
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "text/markdown",
              text,
            } satisfies ResourceContent,
          ],
          _meta: {
            etag: res.etag ?? body?.etag ?? null,
          },
        };
      } catch (err) {
        throw mapResourceError(err);
      }
    },
  );
}

function mapResourceError(err: unknown): McpToolError {
  if (err instanceof McpToolError) return err;
  return new McpToolError(
    "INTERNAL_ERROR",
    (err as Error)?.message ?? "Resource read failed.",
    "Retry once; if the failure persists, check the MCP server logs.",
  );
}
