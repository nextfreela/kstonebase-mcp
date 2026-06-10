import { describe, expect, it, vi } from "vitest";

import { McpToolError } from "./errors.js";
import {
  renderKstonebaseJson,
  runInitLocalBinding,
  type InitLocalBindingDeps,
  type TransportKind,
} from "./setup-tool.js";
import {
  buildToolInventory,
  renderAgentDocs,
} from "./templates/agent-docs.js";

interface FakeClientState {
  workspaces: Record<string, { name: string }>;
  products: Record<
    string,
    {
      name: string;
      specificationManagementType: "free" | "web_application";
      workspaceId: string | null;
    }
  >;
}

function fakeClient(state: FakeClientState) {
  return {
    readWorkspace: vi.fn(async (id: string) => {
      const ws = state.workspaces[id];
      if (!ws) {
        throw new McpToolError(
          "NOT_FOUND",
          `Workspace ${id} not found.`,
          "Check the id with list_workspaces.",
        );
      }
      return { body: { id, ...ws }, etag: null, status: 200 };
    }),
    readProduct: vi.fn(async (id: string) => {
      const p = state.products[id];
      if (!p) {
        throw new McpToolError(
          "NOT_FOUND",
          `Product ${id} not found.`,
          "Check the id with list_products.",
        );
      }
      return { body: { id, ...p }, etag: null, status: 200 };
    }),
    // Other KstonebaseClient methods are not exercised by the setup tool.
  } as unknown as Parameters<typeof runInitLocalBinding>[1]["client"];
}

function deps(
  client: ReturnType<typeof fakeClient>,
  overrides: Partial<InitLocalBindingDeps> = {},
): InitLocalBindingDeps {
  return {
    client,
    cwd: "/tmp/project",
    transport: "stdio" as TransportKind,
    ...overrides,
  };
}

const baseState: FakeClientState = {
  workspaces: { W1: { name: "NextFreela" } },
  products: {
    P_FREE: {
      name: "Kstonebase Website",
      specificationManagementType: "free",
      workspaceId: "W1",
    },
    P_WEB: {
      name: "Some Web App",
      specificationManagementType: "web_application",
      workspaceId: "W1",
    },
    P_ORPHAN: {
      name: "Orphan Product",
      specificationManagementType: "free",
      workspaceId: null,
    },
  },
};

describe("runInitLocalBinding — validation", () => {
  it("rejects when neither id is provided", async () => {
    const client = fakeClient(baseState);
    await expect(
      runInitLocalBinding({}, deps(client)),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("rejects mismatched workspace/product pair", async () => {
    const client = fakeClient({
      ...baseState,
      products: {
        ...baseState.products,
        P_OTHER: {
          name: "Belongs Elsewhere",
          specificationManagementType: "free",
          workspaceId: "W_OTHER",
        },
      },
    });
    await expect(
      runInitLocalBinding(
        { workspaceId: "W1", productId: "P_OTHER" },
        deps(client),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("W1"),
    });
  });

  it("propagates NOT_FOUND from the underlying read", async () => {
    const client = fakeClient(baseState);
    await expect(
      runInitLocalBinding({ productId: "MISSING" }, deps(client)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("propagates TOKEN_SCOPE_MISMATCH from the underlying read", async () => {
    const client = {
      readProduct: vi.fn(async () => {
        throw new McpToolError(
          "TOKEN_SCOPE_MISMATCH",
          "Out of allowlist.",
          "Re-issue the token.",
        );
      }),
      readWorkspace: vi.fn(),
    } as unknown as ReturnType<typeof fakeClient>;
    await expect(
      runInitLocalBinding({ productId: "P_FREE" }, deps(client)),
    ).rejects.toMatchObject({ code: "TOKEN_SCOPE_MISMATCH" });
  });
});

describe("runInitLocalBinding — file plan", () => {
  it("emits .kstonebase.json, CLAUDE.md, AGENTS.md with action=create on a fresh dir", async () => {
    const client = fakeClient(baseState);
    const result = await runInitLocalBinding(
      { workspaceId: "W1", productId: "P_FREE" },
      deps(client),
    );

    expect(result.binding).toEqual({
      workspaceId: "W1",
      workspaceName: "NextFreela",
      productId: "P_FREE",
      productName: "Kstonebase Website",
      productType: "free",
    });
    expect(result.files.map((f) => f.path)).toEqual([
      ".kstonebase.json",
      "CLAUDE.md",
      "AGENTS.md",
    ]);
    for (const f of result.files) {
      expect(f.alreadyExists).toBe(false);
      expect(f.action).toBe("create");
    }
    expect(JSON.parse(result.files[0].content)).toEqual({
      workspaceId: "W1",
      productId: "P_FREE",
    });
    // CLAUDE.md and AGENTS.md bodies must be byte-identical.
    expect(result.files[1].content).toBe(result.files[2].content);
  });

  it("emits only .kstonebase.json when includeAgentDocs is false", async () => {
    const client = fakeClient(baseState);
    const result = await runInitLocalBinding(
      { productId: "P_FREE", includeAgentDocs: false },
      deps(client),
    );
    expect(result.files.map((f) => f.path)).toEqual([".kstonebase.json"]);
  });

  it("binds a workspace only when productId is absent", async () => {
    const client = fakeClient(baseState);
    const result = await runInitLocalBinding(
      { workspaceId: "W1" },
      deps(client),
    );
    expect(JSON.parse(result.files[0].content)).toEqual({ workspaceId: "W1" });
    expect(result.binding.productId).toBeNull();
    expect(result.binding.productType).toBeNull();
  });

  it("binds an orphan product when workspaceId is absent", async () => {
    const client = fakeClient(baseState);
    const result = await runInitLocalBinding(
      { productId: "P_ORPHAN" },
      deps(client),
    );
    expect(JSON.parse(result.files[0].content)).toEqual({
      productId: "P_ORPHAN",
    });
    expect(result.binding.workspaceId).toBeNull();
  });
});

describe("runInitLocalBinding — existing-file handshake", () => {
  it("skips every file when .kstonebase.json matches and templates already exist", async () => {
    const client = fakeClient(baseState);
    const kstonebaseJson = renderKstonebaseJson({
      productId: "P_FREE",
      productName: null,
      productType: null,
      workspaceId: "W1",
      workspaceName: null,
    });
    const result = await runInitLocalBinding(
      {
        workspaceId: "W1",
        productId: "P_FREE",
        existingFiles: [".kstonebase.json", "CLAUDE.md", "AGENTS.md"],
        existingKstonebaseJson: kstonebaseJson,
      },
      deps(client),
    );
    expect(result.files.map((f) => f.action)).toEqual([
      "skip",
      "skip",
      "skip",
    ]);
    for (const f of result.files) {
      expect(f.alreadyExists).toBe(true);
      // Content is still included so the agent can show a diff.
      expect(f.content.length).toBeGreaterThan(0);
    }
    expect(result.nextStep).toContain("Every file is already in place");
  });

  it("marks .kstonebase.json as conflict when existing binds different ids", async () => {
    const client = fakeClient(baseState);
    const result = await runInitLocalBinding(
      {
        productId: "P_FREE",
        existingFiles: [".kstonebase.json"],
        existingKstonebaseJson: JSON.stringify({ productId: "P_OTHER" }, null, 2),
      },
      deps(client),
    );
    const kstonebase = result.files.find((f) => f.path === ".kstonebase.json")!;
    expect(kstonebase.action).toBe("conflict");
    expect(kstonebase.alreadyExists).toBe(true);
    expect(result.nextStep).toContain("conflict");
  });

  it("marks .kstonebase.json as conflict when existing content is unparseable", async () => {
    const client = fakeClient(baseState);
    const result = await runInitLocalBinding(
      {
        productId: "P_FREE",
        existingFiles: [".kstonebase.json"],
        existingKstonebaseJson: "{ not valid json",
      },
      deps(client),
    );
    const kstonebase = result.files.find((f) => f.path === ".kstonebase.json")!;
    expect(kstonebase.action).toBe("conflict");
  });

  it("force=true overwrites every file regardless of state", async () => {
    const client = fakeClient(baseState);
    const result = await runInitLocalBinding(
      {
        productId: "P_FREE",
        force: true,
        existingFiles: [".kstonebase.json", "CLAUDE.md", "AGENTS.md"],
        existingKstonebaseJson: JSON.stringify({ productId: "P_OTHER" }, null, 2),
      },
      deps(client),
    );
    for (const f of result.files) {
      expect(f.action).toBe("overwrite");
      expect(f.alreadyExists).toBe(true);
    }
  });
});

describe("runInitLocalBinding — nextStep per transport", () => {
  it("tells the user to restart the MCP client for the user-run package", async () => {
    const client = fakeClient(baseState);
    const stdio = await runInitLocalBinding(
      { productId: "P_FREE" },
      deps(client, { transport: "stdio" }),
    );
    const http = await runInitLocalBinding(
      { productId: "P_FREE" },
      deps(client, { transport: "http" }),
    );
    expect(stdio.nextStep).toContain("restart");
    expect(http.nextStep).toContain("restart");
  });

  it("omits restart guidance for the remote-endpoint transport", async () => {
    const client = fakeClient(baseState);
    const remote = await runInitLocalBinding(
      { productId: "P_FREE" },
      deps(client, { transport: "remote-endpoint" }),
    );
    expect(remote.nextStep).not.toContain("restart");
    expect(remote.nextStep).toContain("takes effect on the next tool call");
  });
});

describe("renderKstonebaseJson", () => {
  it("emits keys in workspaceId → productId order with a trailing newline", () => {
    const json = renderKstonebaseJson({
      productId: "P",
      productName: null,
      productType: null,
      workspaceId: "W",
      workspaceName: null,
    });
    expect(json.endsWith("\n")).toBe(true);
    const keys = Object.keys(JSON.parse(json));
    expect(keys).toEqual(["workspaceId", "productId"]);
  });

  it("omits keys that are not bound", () => {
    expect(JSON.parse(renderKstonebaseJson({
      productId: null,
      productName: null,
      productType: null,
      workspaceId: "W",
      workspaceName: null,
    }))).toEqual({ workspaceId: "W" });
    expect(JSON.parse(renderKstonebaseJson({
      productId: "P",
      productName: null,
      productType: null,
      workspaceId: null,
      workspaceName: null,
    }))).toEqual({ productId: "P" });
  });
});

describe("agent-docs template", () => {
  it("renders the Golden Rule paragraph verbatim", () => {
    const body = renderAgentDocs({
      productId: "P",
      productName: "Acme",
      productType: "free",
      workspaceId: null,
      workspaceName: null,
    });
    expect(body).toContain("## Golden rule");
    expect(body).toContain(
      "Before writing any spec, planning any feature, or producing non-trivial code",
    );
  });

  it("includes the bound entity's name and id", () => {
    const body = renderAgentDocs({
      productId: "P_FREE",
      productName: "Kstonebase Website",
      productType: "free",
      workspaceId: "W1",
      workspaceName: "NextFreela",
    });
    expect(body).toContain("Kstonebase Website");
    expect(body).toContain("`P_FREE`");
    expect(body).toContain("NextFreela");
    expect(body).toContain("`W1`");
  });

  it("builds the right tool inventory per binding shape", () => {
    const free = buildToolInventory({
      productId: "P",
      productName: "f",
      productType: "free",
      workspaceId: null,
      workspaceName: null,
    });
    expect(free.writes).toContain("create_free_specification");
    expect(free.writes).not.toContain("create_product");

    const web = buildToolInventory({
      productId: "P",
      productName: "w",
      productType: "web_application",
      workspaceId: null,
      workspaceName: null,
    });
    expect(web.writes).not.toContain("create_free_specification");
    expect(web.writes).not.toContain("create_product");

    const workspaceOnly = buildToolInventory({
      productId: null,
      productName: null,
      productType: null,
      workspaceId: "W",
      workspaceName: "ws",
    });
    expect(workspaceOnly.writes).toContain("create_product");
    expect(workspaceOnly.writes).not.toContain("create_free_specification");

    const both = buildToolInventory({
      productId: "P",
      productName: "f",
      productType: "free",
      workspaceId: "W",
      workspaceName: "ws",
    });
    expect(both.writes).toContain("create_free_specification");
    expect(both.writes).toContain("create_product");
  });
});
