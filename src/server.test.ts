import { describe, expect, it, vi } from "vitest";

import { KstonebaseClient } from "./client.js";
import type { ResolvedConfig } from "./config.js";
import { detectLegacyBinding, waitForTransportClose } from "./server.js";

describe("waitForTransportClose", () => {
  it("does not resolve until onclose fires", async () => {
    const transport: { onclose?: () => void } = {};
    const promise = waitForTransportClose(transport);

    let settled = false;
    promise.then(() => {
      settled = true;
    });

    // Yield several microtasks + a macrotask. If the bug regresses (the
    // promise resolving immediately after attaching the handler) `settled`
    // would flip to true here.
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);

    transport.onclose?.();
    await promise;
    expect(settled).toBe(true);
  });

  it("preserves a previously installed onclose handler", async () => {
    let prevCalled = false;
    const transport: { onclose?: () => void } = {
      onclose: () => {
        prevCalled = true;
      },
    };

    const promise = waitForTransportClose(transport);
    transport.onclose?.();
    await promise;

    expect(prevCalled).toBe(true);
  });
});

describe("detectLegacyBinding", () => {
  function configWith(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
    return {
      apiUrl: "https://api.example",
      apiUrlSource: "default",
      token: "kstonebase_pat_x",
      workspaceId: null,
      workspaceSource: "none",
      productId: null,
      productSource: "none",
      bindingMode: "discovery",
      telemetryEnabled: true,
      allowInsecure: false,
      ...overrides,
    };
  }

  function clientWithFetch(fetcher: typeof fetch): KstonebaseClient {
    return new KstonebaseClient({
      apiUrl: "https://api.example",
      token: "kstonebase_pat_x",
      fetcher,
    });
  }

  it("returns null when no workspaceId is bound", async () => {
    const fetcher = vi.fn();
    const result = await detectLegacyBinding(
      configWith(),
      clientWithFetch(fetcher as unknown as typeof fetch),
    );
    expect(result).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns null when the workspaceId resolves to a real Workspace", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/api/mcp/workspaces/")) {
        return new Response(JSON.stringify({ id: "ws_a" }), { status: 200 });
      }
      return new Response("", { status: 404 });
    });
    const result = await detectLegacyBinding(
      configWith({ workspaceId: "ws_a", bindingMode: "workspace" }),
      clientWithFetch(fetcher as unknown as typeof fetch),
    );
    expect(result).toBeNull();
  });

  it("returns LEGACY_BINDING_DETECTED when the id resolves to a Product", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/api/mcp/workspaces/")) {
        return new Response(
          JSON.stringify({ error: { code: "NOT_FOUND" } }),
          { status: 404 },
        );
      }
      if (url.includes("/api/mcp/products/")) {
        return new Response(JSON.stringify({ id: "p_x" }), { status: 200 });
      }
      return new Response("", { status: 404 });
    });
    const result = await detectLegacyBinding(
      configWith({ workspaceId: "p_x", bindingMode: "workspace" }),
      clientWithFetch(fetcher as unknown as typeof fetch),
    );
    expect(result).not.toBeNull();
    expect(result?.code).toBe("LEGACY_BINDING_DETECTED");
  });
});
