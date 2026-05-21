// Tool registration for the MCP server (per Xpec spec "mcp-server" §6
// "Tool naming"). Read-only surface for MVP — write tools land with
// feature #4 (MCP Specification Version Tools).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { XpecClient } from "./client.js";
import type { ResolvedConfig } from "./config.js";
import {
  McpToolError,
  buildClientFailure,
  type McpFailure,
} from "./errors.js";
import { logger } from "./logger.js";

interface ToolDeps {
  client: XpecClient;
  config: ResolvedConfig;
}

/**
 * Resolves the effective product id — explicit argument wins, then the
 * config's `productId` (file or env). Throws PRODUCT_NOT_BOUND when
 * neither is present.
 */
function requireProductId(
  config: ResolvedConfig,
  explicit: string | undefined,
): string {
  if (explicit && explicit.length > 0) return explicit;
  if (config.productId) return config.productId;
  throw new McpToolError(
    "PRODUCT_NOT_BOUND",
    "No product is bound to this MCP session.",
    "Call list_products, pick one, then add it to .xpec.json or set XPEC_PRODUCT_ID.",
  );
}

/**
 * Phase 4: Workspace counterpart. Throws WORKSPACE_NOT_BOUND when the
 * binding doesn't include a Workspace id.
 */
function requireWorkspaceId(
  config: ResolvedConfig,
  explicit: string | undefined,
): string {
  if (explicit && explicit.length > 0) return explicit;
  if (config.workspaceId) return config.workspaceId;
  throw new McpToolError(
    "WORKSPACE_NOT_BOUND",
    "No workspace is bound to this MCP session.",
    "Call list_workspaces, pick one, then add it to .xpec.json as `workspaceId` or set XPEC_WORKSPACE_ID.",
  );
}

interface ListTargetArgs {
  scope?: "workspace" | "product";
  productId?: string;
  workspaceId?: string;
}

/**
 * Phase 4 default-scope resolution for `list_specifications`:
 *   * Both binding ids set                → Product's specs
 *   * workspaceId only                    → Workspace's own specs
 *   * productId only                      → Product's specs
 *   * Explicit `scope` arg                → honoured (with the matching id
 *                                            from args or the binding)
 */
function resolveListSpecificationsTarget(
  config: ResolvedConfig,
  args: ListTargetArgs,
): { scope: "workspace" | "product"; id: string } {
  // Explicit scope wins — but the corresponding id must resolve.
  if (args.scope === "workspace") {
    return { scope: "workspace", id: requireWorkspaceId(config, args.workspaceId) };
  }
  if (args.scope === "product") {
    return { scope: "product", id: requireProductId(config, args.productId) };
  }
  // Explicit ids without a scope arg also win.
  if (args.productId) {
    return { scope: "product", id: args.productId };
  }
  if (args.workspaceId) {
    return { scope: "workspace", id: args.workspaceId };
  }
  // Fall back to the binding-mode default per spec §3.
  if (config.productId) return { scope: "product", id: config.productId };
  if (config.workspaceId)
    return { scope: "workspace", id: config.workspaceId };
  throw new McpToolError(
    "PRODUCT_NOT_BOUND",
    "No product or workspace is bound to this MCP session.",
    "Call list_products or list_workspaces to discover ids, then bind in .xpec.json.",
  );
}

/**
 * Search defaults to the Workspace cross-scope endpoint when bound to a
 * Workspace; that endpoint searches both Workspace specs and every member
 * Product. With only a Product binding it falls through to the
 * Product-scoped search.
 */
function resolveSearchSpecificationsTarget(
  config: ResolvedConfig,
  args: ListTargetArgs,
): { scope: "workspace" | "product"; id: string } {
  if (args.scope === "workspace") {
    return { scope: "workspace", id: requireWorkspaceId(config, args.workspaceId) };
  }
  if (args.scope === "product") {
    return { scope: "product", id: requireProductId(config, args.productId) };
  }
  if (args.workspaceId) {
    return { scope: "workspace", id: args.workspaceId };
  }
  if (args.productId) {
    return { scope: "product", id: args.productId };
  }
  if (config.workspaceId) {
    return { scope: "workspace", id: config.workspaceId };
  }
  if (config.productId) {
    return { scope: "product", id: config.productId };
  }
  throw new McpToolError(
    "PRODUCT_NOT_BOUND",
    "No product or workspace is bound to this MCP session.",
    "Call list_products or list_workspaces to discover ids, then bind in .xpec.json.",
  );
}

// CallToolResult-shaped envelopes. The SDK's typings expect an open-ended
// record with a string index signature, so we use Record<string, unknown>
// rather than a closed interface.
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
} & Record<string, unknown>;

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent:
      typeof data === "object" && data !== null
        ? (data as Record<string, unknown>)
        : { value: data },
  };
}

function fail(failure: McpFailure): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: `${failure.code}: ${failure.message}\n\n${failure.remediation}`,
      },
    ],
    isError: true,
    structuredContent: failure as unknown as Record<string, unknown>,
  };
}

/**
 * Wrap an async tool body so any thrown McpToolError translates to a
 * structured tool failure. Anything else maps to INTERNAL_ERROR — agents
 * can decide whether to retry. Tool calls also emit a debug log line
 * matching the spec's `tool / productId / specId / durationMs / errorCode`
 * shape.
 */
async function runTool(
  name: string,
  context: Record<string, unknown>,
  body: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const startedAt = Date.now();
  try {
    const result = await body();
    logger.debug("tool", {
      tool: name,
      durationMs: Date.now() - startedAt,
      ...context,
    });
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    if (err instanceof McpToolError) {
      logger.warn("tool failed", {
        tool: name,
        durationMs,
        errorCode: err.code,
        ...context,
      });
      return fail(err.toFailure());
    }
    logger.error("tool crashed", {
      tool: name,
      durationMs,
      errorCode: "INTERNAL_ERROR",
      err: (err as Error).message,
      ...context,
    });
    return fail(
      buildClientFailure(
        "INTERNAL_ERROR",
        (err as Error).message ?? "Unexpected MCP server error.",
      ),
    );
  }
}

export function registerReadTools(
  server: McpServer,
  deps: ToolDeps,
): void {
  const { client, config } = deps;

  server.registerTool(
    "list_products",
    {
      title: "List products",
      description:
        "List Products visible to this token. With a Workspace binding, returns the Workspace's member Products; without, returns orphan Products (Products not attached to any Workspace). Read-only. Use this to discover a productId to bind.",
      inputSchema: {
        workspaceId: z.string().optional(),
      },
    },
    async (args) =>
      runTool("list_products", { workspaceId: args.workspaceId }, async () => {
        // Default: when bound to a Workspace, list its member Products.
        // Otherwise list orphan Products so the agent can pick one to bind.
        const explicit = args.workspaceId;
        const wsId = explicit ?? config.workspaceId ?? undefined;
        const res = await client.listProducts(
          wsId ? { workspaceId: wsId } : { orphan: true },
        );
        return ok(res.body);
      }),
  );

  server.registerTool(
    "list_workspaces",
    {
      title: "List workspaces",
      description:
        "List Workspaces visible to this token. Read-only. Use this when discovering which Workspace to bind in .xpec.json.",
      inputSchema: {},
    },
    async () =>
      runTool("list_workspaces", {}, async () => {
        const res = await client.listWorkspaces();
        return ok(res.body);
      }),
  );

  server.registerTool(
    "read_product",
    {
      title: "Read a product",
      description:
        "Read a Product's metadata: name, description, specificationManagementType, and member-of Workspace (when set). Read-only.",
      inputSchema: {
        productId: z.string().optional(),
      },
    },
    async (args) =>
      runTool("read_product", { productId: args.productId }, async () => {
        const productId = requireProductId(config, args.productId);
        const res = await client.readProduct(productId);
        return ok(res.body);
      }),
  );

  server.registerTool(
    "read_workspace",
    {
      title: "Read a workspace",
      description:
        "Read a Workspace's metadata: name, description, specificationManagementType, archived state. Read-only.",
      inputSchema: {
        workspaceId: z.string().optional(),
      },
    },
    async (args) =>
      runTool(
        "read_workspace",
        { workspaceId: args.workspaceId },
        async () => {
          const wsId = requireWorkspaceId(config, args.workspaceId);
          const res = await client.readWorkspace(wsId);
          return ok(res.body);
        },
      ),
  );

  server.registerTool(
    "list_specifications",
    {
      title: "List specifications",
      description:
        "List specifications in scope. Read-only. Default scope follows the binding: when both workspaceId and productId are bound, lists the Product's specs; with only workspaceId, lists the Workspace's own specs; with only productId, lists the Product's specs. Pass `scope` and/or `productId`/`workspaceId` to override. Filters are type-aware: Free scopes accept folder/tag; Web Application Products accept the BUSINESS/UX/DESIGN_SYSTEM type filter.",
      inputSchema: {
        scope: z.enum(["workspace", "product"]).optional(),
        productId: z.string().optional(),
        workspaceId: z.string().optional(),
        type: z
          .enum(["BUSINESS", "UX", "DESIGN_SYSTEM", "DOCUMENT"])
          .optional(),
        status: z
          .enum(["DRAFT", "GENERATING", "NEEDS_REVIEW", "REVIEWED"])
          .optional(),
        folder: z.string().optional(),
        tags: z.array(z.string()).optional(),
        query: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) =>
      runTool(
        "list_specifications",
        {
          scope: args.scope,
          productId: args.productId,
          workspaceId: args.workspaceId,
        },
        async () => {
          const target = resolveListSpecificationsTarget(config, args);
          const query = {
            type: args.type,
            status: args.status,
            folder: args.folder,
            tags: args.tags,
            query: args.query,
            cursor: args.cursor,
            limit: args.limit,
          };
          const res =
            target.scope === "workspace"
              ? await client.listSpecificationsForWorkspace(target.id, query)
              : await client.listSpecifications(target.id, query);
          return ok(res.body);
        },
      ),
  );

  server.registerTool(
    "search_specifications",
    {
      title: "Search specifications",
      description:
        "Lexical full-text search across spec titles and content. Read-only. With a Workspace binding, searches both the Workspace's specs and every member Product; results carry a `scope` discriminator. With only a Product binding, searches that Product's specs.",
      inputSchema: {
        scope: z.enum(["workspace", "product"]).optional(),
        productId: z.string().optional(),
        workspaceId: z.string().optional(),
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(50).optional(),
        includeArchived: z.boolean().optional(),
      },
    },
    async (args) =>
      runTool(
        "search_specifications",
        {
          scope: args.scope,
          productId: args.productId,
          workspaceId: args.workspaceId,
        },
        async () => {
          const target = resolveSearchSpecificationsTarget(config, args);
          const query = {
            query: args.query,
            limit: args.limit,
            includeArchived: args.includeArchived,
          };
          const res =
            target.scope === "workspace"
              ? await client.searchSpecificationsForWorkspace(target.id, query)
              : await client.searchSpecifications(target.id, query);
          return ok(res.body);
        },
      ),
  );

  server.registerTool(
    "read_specification",
    {
      title: "Read a specification",
      description:
        'Read the current Markdown content of a specification. Read-only. Returns the document plus status and version. Use format="rendered" when the agent should ignore open-question and assumption markers.',
      inputSchema: {
        specId: z.string().min(1),
        format: z.enum(["raw", "rendered"]).optional(),
      },
    },
    async (args) =>
      runTool("read_specification", { specId: args.specId }, async () => {
        const res = await client.readSpecification(args.specId, {
          format: args.format,
        });
        if ("notModified" in res) {
          // Not reachable from a tool call (no If-None-Match passed) but
          // typed exhaustively for safety.
          return ok({ notModified: true, etag: res.etag });
        }
        return ok(res.body);
      }),
  );

  server.registerTool(
    "list_specification_versions",
    {
      title: "List approved versions",
      description:
        "List the approved (user-marked Reviewed) snapshots for a specification, newest first. Read-only.",
      inputSchema: {
        specId: z.string().min(1),
      },
    },
    async (args) =>
      runTool(
        "list_specification_versions",
        { specId: args.specId },
        async () => {
          const res = await client.listSpecificationVersions(args.specId);
          return ok(res.body);
        },
      ),
  );

  server.registerTool(
    "read_specification_version",
    {
      title: "Read an approved version",
      description:
        "Read the full Markdown of a specific approved revision. Read-only. Use this with list_specification_versions to compare past wording with current content.",
      inputSchema: {
        specId: z.string().min(1),
        revisionId: z.string().min(1),
      },
    },
    async (args) =>
      runTool(
        "read_specification_version",
        { specId: args.specId },
        async () => {
          const res = await client.readSpecificationVersion(
            args.specId,
            args.revisionId,
          );
          if ("notModified" in res) {
            return ok({ notModified: true, etag: res.etag });
          }
          return ok(res.body);
        },
      ),
  );

  server.registerTool(
    "list_open_questions",
    {
      title: "List open questions",
      description:
        "List the questions and assumptions attached to a specification. Read-only. Resolved or dismissed items are excluded by default; pass includeResolved=true to surface the full set.",
      inputSchema: {
        specId: z.string().min(1),
        includeResolved: z.boolean().optional(),
      },
    },
    async (args) =>
      runTool("list_open_questions", { specId: args.specId }, async () => {
        const res = await client.listOpenQuestions(args.specId, {
          includeResolved: args.includeResolved,
        });
        return ok(res.body);
      }),
  );

  // ────────────────────────────────────────────────────────────────────
  // Knowledge-layer read tool (per Xpec MCP spec
  // "mcp-knowledge-layer-tools").
  // ────────────────────────────────────────────────────────────────────

  server.registerTool(
    "find_product_by_subject",
    {
      title: "Find products by subject",
      description:
        "Search for Products in the bound Workspace by a free-text subject. Read-only. Returns candidates ranked by a lexical score across name, tags, and description. Use this when the agent needs to choose which Product is about a given topic; the calling agent is expected to do its own semantic reranking.",
      inputSchema: {
        workspaceId: z.string().optional(),
        subject: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (args) =>
      runTool(
        "find_product_by_subject",
        { workspaceId: args.workspaceId },
        async () => {
          const wsId = requireWorkspaceId(config, args.workspaceId);
          const res = await client.findProductBySubject(wsId, {
            subject: args.subject,
            limit: args.limit,
          });
          return ok(res.body);
        },
      ),
  );
}

export function registerWriteTools(
  server: McpServer,
  deps: ToolDeps,
): void {
  const { client, config } = deps;

  server.registerTool(
    "start_new_version",
    {
      title: "Start a new draft",
      description:
        "Open a new draft of a Reviewed specification. Side effect: status becomes Draft. Does not bump the user-visible version. Required before update_specification_content on a published spec. No-op when the spec is already in Draft (response carries hint=\"already_draft\").",
      inputSchema: { specId: z.string().min(1) },
    },
    async (args) =>
      runTool("start_new_version", { specId: args.specId }, async () => {
        const res = await client.startNewVersion(args.specId);
        return ok(res.body);
      }),
  );

  server.registerTool(
    "update_specification_content",
    {
      title: "Replace a draft's full content",
      description:
        "Replace the entire Markdown body of a Draft specification. Side effect: content + OCC version are updated. Pass `version` from the most recent read to detect concurrent edits. Returns 409 STALE_VERSION when another writer landed first — re-read and retry.",
      inputSchema: {
        specId: z.string().min(1),
        content: z.string().max(1_000_000),
        version: z.number().int().min(1),
      },
    },
    async (args) =>
      runTool(
        "update_specification_content",
        { specId: args.specId },
        async () => {
          const res = await client.updateSpecificationContent(args.specId, {
            content: args.content,
            version: args.version,
          });
          return ok(res.body);
        },
      ),
  );

  server.registerTool(
    "update_specification_section",
    {
      title: "Replace a single section of a draft",
      description:
        'Replace one heading-bound section of a Draft specification (e.g. sectionPath="## Pricing"). Side effect: the section text is replaced atomically and a before-image revision is recorded. OCC-guarded — pass `version` from the most recent read.',
      inputSchema: {
        specId: z.string().min(1),
        sectionPath: z.string().trim().min(1).max(200),
        newSection: z.string().max(1_000_000),
        version: z.number().int().min(1),
      },
    },
    async (args) =>
      runTool(
        "update_specification_section",
        { specId: args.specId },
        async () => {
          const res = await client.updateSpecificationSection(args.specId, {
            sectionPath: args.sectionPath,
            newSection: args.newSection,
            version: args.version,
          });
          return ok(res.body);
        },
      ),
  );

  server.registerTool(
    "request_review",
    {
      title: "Request review on a draft",
      description:
        "Move a Draft specification to Needs Review so a human can mark it Reviewed in Xpec. Gated on the spec having no open questions — if questions remain, the response returns OPEN_QUESTIONS_PRESENT and the agent should surface them to the user.",
      inputSchema: { specId: z.string().min(1) },
    },
    async (args) =>
      runTool("request_review", { specId: args.specId }, async () => {
        const res = await client.requestReview(args.specId);
        return ok(res.body);
      }),
  );

  server.registerTool(
    "discard_draft",
    {
      title: "Discard the current draft",
      description:
        "Roll a Draft (or Needs Review) specification back to its last approved version. Side effect: content is restored from the latest approved revision and status returns to Reviewed. Rejected when the spec has never been approved.",
      inputSchema: { specId: z.string().min(1) },
    },
    async (args) =>
      runTool("discard_draft", { specId: args.specId }, async () => {
        const res = await client.discardDraft(args.specId);
        return ok(res.body);
      }),
  );

  // ────────────────────────────────────────────────────────────────────
  // Knowledge-layer write tools (per Xpec MCP spec
  // "mcp-knowledge-layer-tools").
  // ────────────────────────────────────────────────────────────────────

  server.registerTool(
    "create_product",
    {
      title: "Create a Product in the bound Workspace",
      description:
        'Create a new Product inside the bound Workspace. Side effect: a new Product row is created with specificationManagementType="free" by default. Requires a Workspace-scope binding; product-allowlist credentials cannot create Products.',
      inputSchema: {
        workspaceId: z.string().optional(),
        name: z.string().trim().min(1).max(80),
        description: z.string().max(280).optional(),
        tags: z.array(z.string().min(1).max(40)).max(32).optional(),
        specificationManagementType: z
          .enum(["free", "web_application"])
          .optional(),
      },
    },
    async (args) =>
      runTool(
        "create_product",
        { workspaceId: args.workspaceId },
        async () => {
          const wsId = requireWorkspaceId(config, args.workspaceId);
          const res = await client.createProduct(wsId, {
            name: args.name,
            description: args.description,
            tags: args.tags,
            specificationManagementType: args.specificationManagementType,
          });
          return ok(res.body);
        },
      ),
  );

  server.registerTool(
    "append_context",
    {
      title: "Append a dated section of context to a draft",
      description:
        'Append a dated section of Markdown to a Draft specification. Side effect: a new section titled "YYYY-MM-DD — {sectionTitle}" is appended, or the existing same-day section grows downward, via the existing section-apply path. Inherits OCC, the before-image revision, and the Draft-only lock from update_specification_section.',
      inputSchema: {
        specId: z.string().min(1),
        content: z.string().min(1).max(1_000_000),
        sectionTitle: z.string().trim().min(1).max(100).optional(),
        version: z.number().int().min(1),
      },
    },
    async (args) =>
      runTool("append_context", { specId: args.specId }, async () => {
        const res = await client.appendContext(args.specId, {
          content: args.content,
          sectionTitle: args.sectionTitle,
          version: args.version,
        });
        return ok(res.body);
      }),
  );

  // Free-spec creation only makes sense when the bound product is Free.
  // The API enforces this with PRODUCT_TYPE_MISMATCH, but the tool stays
  // listed unconditionally so the agent can call it after binding to a
  // Free product — the type check at call time matches the spec's
  // documented behaviour better than an opaque "tool not found".
  server.registerTool(
    "create_free_specification",
    {
      title: "Create a Free product specification",
      description:
        "Create a new Markdown specification in the bound Free product. Side effect: a new spec row is created at status=Draft, approvedVersion=1. Path uniqueness is enforced. Rejected with PRODUCT_TYPE_MISMATCH when the product is Web Application — use start_new_version on an existing structured spec instead.",
      inputSchema: {
        productId: z.string().optional(),
        title: z.string().min(1).max(200),
        path: z.string().optional(),
        tags: z.array(z.string()).optional(),
        content: z.string().optional(),
      },
    },
    async (args) =>
      runTool(
        "create_free_specification",
        { productId: args.productId },
        async () => {
          const wsId = requireProductId(config, args.productId);
          const res = await client.createFreeSpecification(wsId, {
            title: args.title,
            path: args.path,
            tags: args.tags,
            content: args.content,
          });
          return ok(res.body);
        },
      ),
  );
}
