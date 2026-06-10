import { describe, expect, it, vi } from "vitest";

import { KstonebaseClient } from "./client.js";
import { McpToolError } from "./errors.js";

interface MockResponseInit {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  textBody?: string;
}

function mockResponse(init: MockResponseInit = {}): Response {
  const status = init.status ?? 200;
  const text =
    init.textBody !== undefined
      ? init.textBody
      : init.body !== undefined
        ? JSON.stringify(init.body)
        : "";
  const headers = new Headers(init.headers ?? {});
  // 304 / 204 etc. forbid a body in the spec, so build a minimal
  // Response-shaped object directly rather than going through the web
  // constructor (which throws for null-body statuses).
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: async () => text,
  } as unknown as Response;
}

describe("KstonebaseClient — auth header", () => {
  it("attaches Authorization: Bearer on every call", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      mockResponse({ body: { items: [] } }),
    );
    const client = new KstonebaseClient({
      apiUrl: "https://app.example.com",
      token: "kstonebase_pat_TESTTOKEN",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await client.listProducts();
    expect(fetcher).toHaveBeenCalledOnce();
    const [, init] = fetcher.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer kstonebase_pat_TESTTOKEN");
  });

  it("strips trailing slashes on the base URL", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      mockResponse({ body: { items: [] } }),
    );
    const client = new KstonebaseClient({
      apiUrl: "https://app.example.com//",
      token: "t",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await client.listProducts();
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://app.example.com/api/mcp/products",
    );
  });
});

describe("KstonebaseClient — list_specifications query encoding", () => {
  it("repeats the tag param for each tag", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      mockResponse({ body: { items: [] } }),
    );
    const client = new KstonebaseClient({
      apiUrl: "https://x.example",
      token: "t",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await client.listSpecifications("ws_1", { tags: ["a", "b"] });
    const url = fetcher.mock.calls[0][0] as string;
    expect(url).toContain("tag=a");
    expect(url).toContain("tag=b");
  });
});

describe("KstonebaseClient — etag handling", () => {
  it("forwards If-None-Match and surfaces a 304 NotModified", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const ifNoneMatch = (init?.headers as Record<string, string>)[
        "if-none-match"
      ];
      if (ifNoneMatch === 'W/"v5-raw"') {
        return mockResponse({ status: 304, headers: { etag: 'W/"v5-raw"' } });
      }
      return mockResponse({ body: { content: "...", etag: 'W/"v5-raw"' } });
    });
    const client = new KstonebaseClient({
      apiUrl: "https://x.example",
      token: "t",
      fetcher: fetcher as unknown as typeof fetch,
    });
    const res = await client.readSpecification("spec_1", {
      ifNoneMatch: 'W/"v5-raw"',
    });
    expect(res).toEqual({ notModified: true, etag: 'W/"v5-raw"', status: 304 });
  });

  it("returns the etag header on 200 responses", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      mockResponse({
        body: { content: "x" },
        headers: { etag: 'W/"v5-raw"' },
      }),
    );
    const client = new KstonebaseClient({
      apiUrl: "https://x.example",
      token: "t",
      fetcher: fetcher as unknown as typeof fetch,
    });
    const res = await client.readSpecification("spec_1");
    expect("etag" in res ? res.etag : null).toBe('W/"v5-raw"');
  });
});

describe("KstonebaseClient — error mapping", () => {
  it("maps an API 401 to AUTH_FAILED", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      mockResponse({
        status: 401,
        body: { error: { code: "UNAUTHORIZED", message: "no auth" } },
      }),
    );
    const client = new KstonebaseClient({
      apiUrl: "https://x.example",
      token: "t",
      fetcher: fetcher as unknown as typeof fetch,
    });
    const err = await client.listProducts().catch((e) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).code).toBe("AUTH_FAILED");
  });

  it("maps PRODUCT_TYPE_MISMATCH from the body's details.code", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      mockResponse({
        status: 400,
        body: {
          error: {
            message: "Type doesn't fit",
            details: { code: "PRODUCT_TYPE_MISMATCH" },
          },
        },
      }),
    );
    const client = new KstonebaseClient({
      apiUrl: "https://x.example",
      token: "t",
      fetcher: fetcher as unknown as typeof fetch,
    });
    const err = await client
      .listSpecifications("ws_1", { type: "BUSINESS" })
      .catch((e) => e);
    expect((err as McpToolError).code).toBe("PRODUCT_TYPE_MISMATCH");
  });
});

describe("KstonebaseClient — checkAuth", () => {
  it("returns the product count on success", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      mockResponse({ body: { items: [{ id: "ws_a" }, { id: "ws_b" }] } }),
    );
    const client = new KstonebaseClient({
      apiUrl: "https://x.example",
      token: "t",
      fetcher: fetcher as unknown as typeof fetch,
    });
    const probe = await client.checkAuth();
    expect(probe).toEqual({ ok: true, products: 2 });
  });
});
