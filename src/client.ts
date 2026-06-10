// Kstonebase HTTP API client. Wraps the /api/mcp/* surface so tool
// handlers stay focused on argument shaping. Every outbound request carries
// `Authorization: Bearer kstonebase_pat_…`; no other auth artifacts are sent
// (per Kstonebase spec "mcp-server" §5 "Auth header").

import { McpToolError, mapApiError, type ApiErrorBody } from "./errors.js";

export interface ClientOptions {
  apiUrl: string;
  token: string;
  /** Test override — replaces global fetch. */
  fetcher?: typeof fetch;
}

export interface ListSpecificationsQuery {
  type?: string;
  status?: string;
  folder?: string;
  tags?: string[];
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface ReadSpecificationQuery {
  format?: "raw" | "rendered";
  /** Pass through to honour `If-None-Match` on the resource layer. */
  ifNoneMatch?: string;
}

export interface SearchQuery {
  query: string;
  limit?: number;
  includeArchived?: boolean;
}

export interface ListOpenQuestionsQuery {
  includeResolved?: boolean;
}

export interface ApiResponse<T> {
  body: T;
  etag: string | null;
  status: number;
}

export interface NotModified {
  notModified: true;
  etag: string;
  status: 304;
}

export class KstonebaseClient {
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;

  constructor(options: ClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetcher = options.fetcher ?? fetch;
  }

  // ────────────────────────────────────────────────────────────────────
  // Read endpoints
  // ────────────────────────────────────────────────────────────────────

  listProducts(
    options: { workspaceId?: string; orphan?: boolean } = {},
  ): Promise<ApiResponse<unknown>> {
    const params = new URLSearchParams();
    if (options.workspaceId) params.set("workspaceId", options.workspaceId);
    if (options.orphan) params.set("orphan", "true");
    const qs = params.toString();
    return this.getJson(`/api/mcp/products${qs ? `?${qs}` : ""}`);
  }

  listWorkspaces(): Promise<ApiResponse<unknown>> {
    return this.getJson("/api/mcp/workspaces");
  }

  readProduct(productId: string): Promise<ApiResponse<unknown>> {
    return this.getJson(`/api/mcp/products/${encodeURIComponent(productId)}`);
  }

  readWorkspace(workspaceId: string): Promise<ApiResponse<unknown>> {
    return this.getJson(
      `/api/mcp/workspaces/${encodeURIComponent(workspaceId)}`,
    );
  }

  listSpecifications(
    productId: string,
    query: ListSpecificationsQuery = {},
  ): Promise<ApiResponse<unknown>> {
    const params = new URLSearchParams();
    if (query.type) params.set("type", query.type);
    if (query.status) params.set("status", query.status);
    if (query.folder) params.set("folder", query.folder);
    if (query.query) params.set("query", query.query);
    if (query.cursor) params.set("cursor", query.cursor);
    if (typeof query.limit === "number") {
      params.set("limit", String(query.limit));
    }
    if (query.tags) {
      for (const t of query.tags) params.append("tag", t);
    }
    const qs = params.toString();
    return this.getJson(
      `/api/mcp/products/${encodeURIComponent(productId)}/specifications${qs ? `?${qs}` : ""}`,
    );
  }

  searchSpecifications(
    productId: string,
    query: SearchQuery,
  ): Promise<ApiResponse<unknown>> {
    const params = new URLSearchParams({ query: query.query });
    if (typeof query.limit === "number") {
      params.set("limit", String(query.limit));
    }
    if (query.includeArchived) {
      params.set("includeArchived", "true");
    }
    return this.getJson(
      `/api/mcp/products/${encodeURIComponent(productId)}/specifications/search?${params.toString()}`,
    );
  }

  /**
   * Phase 4: Workspace-scoped specification list. Calls the MCP workspace
   * route which enforces workspace ownership and Free-management semantics.
   */
  listSpecificationsForWorkspace(
    workspaceId: string,
    query: ListSpecificationsQuery = {},
  ): Promise<ApiResponse<unknown>> {
    const params = new URLSearchParams();
    if (query.type) params.set("type", query.type);
    if (query.status) params.set("status", query.status);
    if (query.folder) params.set("folder", query.folder);
    if (query.query) params.set("query", query.query);
    if (query.cursor) params.set("cursor", query.cursor);
    if (typeof query.limit === "number") {
      params.set("limit", String(query.limit));
    }
    if (query.tags) {
      for (const t of query.tags) params.append("tag", t);
    }
    const qs = params.toString();
    return this.getJson(
      `/api/mcp/workspaces/${encodeURIComponent(workspaceId)}/specifications${qs ? `?${qs}` : ""}`,
    );
  }

  /**
   * Phase 4: cross-scope search. The server fans out to the Workspace's
   * own specs and to every member Product, then merges and scores.
   */
  searchSpecificationsForWorkspace(
    workspaceId: string,
    query: SearchQuery,
  ): Promise<ApiResponse<unknown>> {
    const params = new URLSearchParams({ query: query.query });
    if (typeof query.limit === "number") {
      params.set("limit", String(query.limit));
    }
    if (query.includeArchived) {
      params.set("includeArchived", "true");
    }
    return this.getJson(
      `/api/mcp/workspaces/${encodeURIComponent(workspaceId)}/specifications/search?${params.toString()}`,
    );
  }

  readSpecification(
    specId: string,
    query: ReadSpecificationQuery = {},
  ): Promise<ApiResponse<unknown> | NotModified> {
    const params = new URLSearchParams();
    if (query.format) params.set("format", query.format);
    const qs = params.toString();
    return this.get(
      `/api/mcp/specifications/${encodeURIComponent(specId)}${qs ? `?${qs}` : ""}`,
      query.ifNoneMatch,
    );
  }

  listSpecificationVersions(specId: string): Promise<ApiResponse<unknown>> {
    return this.getJson(
      `/api/mcp/specifications/${encodeURIComponent(specId)}/versions`,
    );
  }

  readSpecificationVersion(
    specId: string,
    revisionId: string,
    ifNoneMatch?: string,
  ): Promise<ApiResponse<unknown> | NotModified> {
    return this.get(
      `/api/mcp/specifications/${encodeURIComponent(specId)}/versions/${encodeURIComponent(revisionId)}`,
      ifNoneMatch,
    );
  }

  listOpenQuestions(
    specId: string,
    query: ListOpenQuestionsQuery = {},
  ): Promise<ApiResponse<unknown>> {
    const params = new URLSearchParams();
    if (query.includeResolved) params.set("includeResolved", "true");
    const qs = params.toString();
    return this.getJson(
      `/api/mcp/specifications/${encodeURIComponent(specId)}/open-questions${qs ? `?${qs}` : ""}`,
    );
  }

  /** Convenience for endpoints that never send If-None-Match — narrows the
   *  union so callers don't have to discriminate on `notModified`. */
  private async getJson(path: string): Promise<ApiResponse<unknown>> {
    const res = await this.get(path);
    if ("notModified" in res) {
      // Should not happen — getJson never asks for conditional requests.
      throw new Error("Unexpected 304 on a non-conditional request.");
    }
    return res;
  }

  private postJson(path: string): Promise<ApiResponse<unknown>> {
    return this.sendJson("POST", path, undefined);
  }

  private async sendJson(
    method: "POST" | "PATCH",
    path: string,
    body: unknown,
  ): Promise<ApiResponse<unknown>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    const res = await this.fetcher(`${this.apiUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    const parsed =
      text.length > 0
        ? (safeParseJson(text) as ApiErrorBody | unknown)
        : null;

    if (!res.ok) {
      throw mapApiError(res.status, parsed as ApiErrorBody | null);
    }

    return {
      body: parsed,
      etag: res.headers.get("etag"),
      status: res.status,
    };
  }

  /**
   * `--check` smoke probe: hits /api/mcp/products and returns the count
   * (or throws on auth failure). Cheaper than a full preflight: the same
   * call the agent does on its first list.
   */
  async checkAuth(): Promise<{ ok: true; products: number }> {
    const res = await this.listProducts();
    const items = (res.body as { items?: unknown[] } | null)?.items;
    return { ok: true, products: Array.isArray(items) ? items.length : 0 };
  }

  /**
   * Phase 4: probe whether a given id resolves to a Workspace, a Product,
   * or neither. Used at server startup to detect the legacy binding shape
   * (`{"workspaceId": "<old id>"}` where `<old id>` is now a Product id).
   * Errors other than 404 propagate so the caller can decide whether to
   * keep going.
   */
  async resolveIdShape(
    id: string,
  ): Promise<"workspace" | "product" | "unknown"> {
    try {
      await this.readWorkspace(id);
      return "workspace";
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    try {
      await this.readProduct(id);
      return "product";
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    return "unknown";
  }

  // ────────────────────────────────────────────────────────────────────
  // Write endpoints
  // ────────────────────────────────────────────────────────────────────

  startNewVersion(specId: string): Promise<ApiResponse<unknown>> {
    return this.postJson(
      `/api/mcp/specifications/${encodeURIComponent(specId)}/start-new-version`,
    );
  }

  updateSpecificationContent(
    specId: string,
    body: { content: string; version: number },
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "PATCH",
      `/api/mcp/specifications/${encodeURIComponent(specId)}/content`,
      body,
    );
  }

  updateSpecificationSection(
    specId: string,
    body: { sectionPath: string; newSection: string; version: number },
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "PATCH",
      `/api/mcp/specifications/${encodeURIComponent(specId)}/section`,
      body,
    );
  }

  requestReview(specId: string): Promise<ApiResponse<unknown>> {
    return this.postJson(
      `/api/mcp/specifications/${encodeURIComponent(specId)}/request-review`,
    );
  }

  discardDraft(specId: string): Promise<ApiResponse<unknown>> {
    return this.postJson(
      `/api/mcp/specifications/${encodeURIComponent(specId)}/discard-draft`,
    );
  }

  createFreeSpecification(
    productId: string,
    body: {
      title: string;
      path?: string;
      tags?: string[];
      content?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "POST",
      `/api/mcp/products/${encodeURIComponent(productId)}/specifications`,
      body,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Knowledge-layer endpoints (per Kstonebase MCP spec
  // "mcp-knowledge-layer-tools").
  // ────────────────────────────────────────────────────────────────────

  createProduct(
    workspaceId: string,
    body: {
      name: string;
      description?: string;
      tags?: string[];
      specificationManagementType?: "free" | "web_application";
    },
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "POST",
      `/api/mcp/workspaces/${encodeURIComponent(workspaceId)}/products`,
      body,
    );
  }

  findProductBySubject(
    workspaceId: string,
    query: { subject: string; limit?: number },
  ): Promise<ApiResponse<unknown>> {
    const params = new URLSearchParams({ subject: query.subject });
    if (typeof query.limit === "number") {
      params.set("limit", String(query.limit));
    }
    return this.getJson(
      `/api/mcp/workspaces/${encodeURIComponent(workspaceId)}/products/search?${params.toString()}`,
    );
  }

  appendContext(
    specId: string,
    body: {
      content: string;
      sectionTitle?: string;
      version: number;
    },
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "POST",
      `/api/mcp/specifications/${encodeURIComponent(specId)}/append-context`,
      body,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────

  private async get(
    path: string,
    ifNoneMatch?: string,
  ): Promise<ApiResponse<unknown> | NotModified> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
    };
    if (ifNoneMatch) headers["if-none-match"] = ifNoneMatch;

    const res = await this.fetcher(`${this.apiUrl}${path}`, {
      method: "GET",
      headers,
    });

    if (res.status === 304) {
      return {
        notModified: true,
        etag: res.headers.get("etag") ?? "",
        status: 304,
      };
    }

    const text = await res.text();
    const body =
      text.length > 0
        ? (safeParseJson(text) as ApiErrorBody | unknown)
        : null;

    if (!res.ok) {
      throw mapApiError(res.status, body as ApiErrorBody | null);
    }

    return {
      body,
      etag: res.headers.get("etag"),
      status: res.status,
    };
  }
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: "API returned a non-JSON payload." } };
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof McpToolError && err.code === "NOT_FOUND";
}
