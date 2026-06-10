import { describe, expect, it } from "vitest";

import { ConfigError, DEFAULT_API_URL, resolveConfig } from "./config.js";

function fileReaderFor(map: Record<string, string>) {
  return (path: string) => map[path] ?? null;
}

const TEST_CWD = "/proj";
const FILE_PATH = "/proj/.kstonebase.json";

describe("resolveConfig — binding precedence", () => {
  it("uses .kstonebase.json productId when present (overrides env)", () => {
    const config = resolveConfig({
      cwd: TEST_CWD,
      env: {
        NODE_ENV: "test",
        KSTONEBASE_API_TOKEN: "kstonebase_pat_x",
        KSTONEBASE_PRODUCT_ID: "p_env",
      },
      fileReader: fileReaderFor({
        [FILE_PATH]: JSON.stringify({ productId: "p_file" }),
      }),
    });
    expect(config.productId).toBe("p_file");
    expect(config.productSource).toBe("config-file");
    expect(config.workspaceId).toBeNull();
    expect(config.bindingMode).toBe("product");
  });

  it("falls back to env when no file is present", () => {
    const config = resolveConfig({
      cwd: TEST_CWD,
      env: {
        NODE_ENV: "test",
        KSTONEBASE_API_TOKEN: "kstonebase_pat_x",
        KSTONEBASE_PRODUCT_ID: "p_env",
      },
      fileReader: fileReaderFor({}),
    });
    expect(config.productId).toBe("p_env");
    expect(config.productSource).toBe("env");
    expect(config.bindingMode).toBe("product");
  });

  it("resolves workspaceId from the config file", () => {
    const config = resolveConfig({
      cwd: TEST_CWD,
      env: { NODE_ENV: "test", KSTONEBASE_API_TOKEN: "kstonebase_pat_x" },
      fileReader: fileReaderFor({
        [FILE_PATH]: JSON.stringify({ workspaceId: "ws_a" }),
      }),
    });
    expect(config.workspaceId).toBe("ws_a");
    expect(config.workspaceSource).toBe("config-file");
    expect(config.productId).toBeNull();
    expect(config.bindingMode).toBe("workspace");
  });

  it("resolves KSTONEBASE_WORKSPACE_ID from env", () => {
    const config = resolveConfig({
      cwd: TEST_CWD,
      env: {
        NODE_ENV: "test",
        KSTONEBASE_API_TOKEN: "kstonebase_pat_x",
        KSTONEBASE_WORKSPACE_ID: "ws_env",
      },
      fileReader: fileReaderFor({}),
    });
    expect(config.workspaceId).toBe("ws_env");
    expect(config.workspaceSource).toBe("env");
    expect(config.bindingMode).toBe("workspace");
  });

  it("supports binding to a Product inside a Workspace", () => {
    const config = resolveConfig({
      cwd: TEST_CWD,
      env: { NODE_ENV: "test", KSTONEBASE_API_TOKEN: "kstonebase_pat_x" },
      fileReader: fileReaderFor({
        [FILE_PATH]: JSON.stringify({
          workspaceId: "ws_a",
          productId: "p_b",
        }),
      }),
    });
    expect(config.workspaceId).toBe("ws_a");
    expect(config.productId).toBe("p_b");
    expect(config.bindingMode).toBe("workspace+product");
  });

  it("returns 'discovery' mode when neither id is set", () => {
    const config = resolveConfig({
      cwd: TEST_CWD,
      env: { NODE_ENV: "test", KSTONEBASE_API_TOKEN: "kstonebase_pat_x" },
      fileReader: fileReaderFor({}),
    });
    expect(config.workspaceId).toBeNull();
    expect(config.productId).toBeNull();
    expect(config.bindingMode).toBe("discovery");
  });

  it("accepts a config file without any binding ids (discovery mode)", () => {
    const config = resolveConfig({
      cwd: TEST_CWD,
      env: { NODE_ENV: "test", KSTONEBASE_API_TOKEN: "kstonebase_pat_x" },
      fileReader: fileReaderFor({
        [FILE_PATH]: JSON.stringify({ apiUrl: "https://x.example" }),
      }),
    });
    expect(config.bindingMode).toBe("discovery");
  });

  it("rejects a malformed config file", () => {
    expect(() =>
      resolveConfig({
        cwd: TEST_CWD,
        env: {
        NODE_ENV: "test", KSTONEBASE_API_TOKEN: "kstonebase_pat_x" },
        fileReader: fileReaderFor({ [FILE_PATH]: "{not json}" }),
      }),
    ).toThrow(ConfigError);
  });
});

describe("resolveConfig — apiUrl", () => {
  it("defaults to the hosted URL when nothing is set", () => {
    const config = resolveConfig({
      cwd: TEST_CWD,
      env: {
        NODE_ENV: "test", KSTONEBASE_API_TOKEN: "kstonebase_pat_x" },
      fileReader: fileReaderFor({}),
    });
    expect(config.apiUrl).toBe(DEFAULT_API_URL);
    expect(config.apiUrlSource).toBe("default");
  });

  it("strips trailing slashes", () => {
    const config = resolveConfig({
      cwd: TEST_CWD,
      env: {
        NODE_ENV: "test",
        KSTONEBASE_API_TOKEN: "kstonebase_pat_x",
        KSTONEBASE_API_URL: "https://app.example.com//",
      },
      fileReader: fileReaderFor({}),
    });
    expect(config.apiUrl).toBe("https://app.example.com");
  });

  it("argument > file > env precedence", () => {
    const config = resolveConfig({
      apiUrl: "https://arg.example",
      cwd: TEST_CWD,
      env: {
        NODE_ENV: "test",
        KSTONEBASE_API_TOKEN: "kstonebase_pat_x",
        KSTONEBASE_API_URL: "https://env.example",
      },
      fileReader: fileReaderFor({
        [FILE_PATH]: JSON.stringify({
          productId: "p_x",
          apiUrl: "https://file.example",
        }),
      }),
    });
    expect(config.apiUrl).toBe("https://arg.example");
    expect(config.apiUrlSource).toBe("argument");
  });

  it("rejects http:// without --allow-insecure", () => {
    expect(() =>
      resolveConfig({
        cwd: TEST_CWD,
        env: {
        NODE_ENV: "test",
          KSTONEBASE_API_TOKEN: "kstonebase_pat_x",
          KSTONEBASE_API_URL: "http://app.example.com",
        },
        fileReader: fileReaderFor({}),
      }),
    ).toThrow(ConfigError);
  });

  it("permits http://localhost without --allow-insecure", () => {
    const config = resolveConfig({
      cwd: TEST_CWD,
      env: {
        NODE_ENV: "test",
        KSTONEBASE_API_TOKEN: "kstonebase_pat_x",
        KSTONEBASE_API_URL: "http://localhost:3000",
      },
      fileReader: fileReaderFor({}),
    });
    expect(config.apiUrl).toBe("http://localhost:3000");
  });

  it("permits http:// when --allow-insecure is set", () => {
    const config = resolveConfig({
      allowInsecure: true,
      cwd: TEST_CWD,
      env: {
        NODE_ENV: "test",
        KSTONEBASE_API_TOKEN: "kstonebase_pat_x",
        KSTONEBASE_API_URL: "http://app.example.com",
      },
      fileReader: fileReaderFor({}),
    });
    expect(config.apiUrl).toBe("http://app.example.com");
  });
});

describe("resolveConfig — telemetry", () => {
  it("disables telemetry when KSTONEBASE_TELEMETRY=0", () => {
    const config = resolveConfig({
      cwd: TEST_CWD,
      env: {
        NODE_ENV: "test",
        KSTONEBASE_API_TOKEN: "kstonebase_pat_x",
        KSTONEBASE_TELEMETRY: "0",
      },
      fileReader: fileReaderFor({}),
    });
    expect(config.telemetryEnabled).toBe(false);
  });

  it("leaves telemetry on by default", () => {
    const config = resolveConfig({
      cwd: TEST_CWD,
      env: {
        NODE_ENV: "test", KSTONEBASE_API_TOKEN: "kstonebase_pat_x" },
      fileReader: fileReaderFor({}),
    });
    expect(config.telemetryEnabled).toBe(true);
  });
});

describe("resolveConfig — token", () => {
  it("returns null token when env var is missing (the CLI exits with a hint)", () => {
    const config = resolveConfig({
      cwd: TEST_CWD,
      env: {
        NODE_ENV: "test",},
      fileReader: fileReaderFor({}),
    });
    expect(config.token).toBeNull();
  });
});
