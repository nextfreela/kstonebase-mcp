// Config + binding resolution (per Kstonebase specs "mcp-server" §3+§6
// and "mcp-workspace-tools" §4). Phase 4 of the Workspaces epic introduces
// an aggregation layer above Products, so a project binding can name either
// a Workspace, a Product, or both.
//
// Precedence per binding key (workspaceId, productId):
//   1. `.kstonebase.json` at the project root
//   2. `KSTONEBASE_WORKSPACE_ID` / `KSTONEBASE_PRODUCT_ID` env vars
//   3. unset
//
// Effective binding mode is computed from the resolved pair:
//   * both set         → "workspace+product"
//   * workspaceId only → "workspace"
//   * productId only   → "product"  (orphan / pre-aggregation Product)
//   * neither          → "discovery" (only list_workspaces / list_products
//                         orphan-only are usable until ids are passed)
//
// API URL precedence:
//   1. `--api-url` command-line flag (parsed in cli.ts)
//   2. `apiUrl` in `.kstonebase.json`
//   3. `KSTONEBASE_API_URL` environment variable
//   4. https://kstonebase.com (default)

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export const DEFAULT_API_URL = "https://kstonebase.com";
export const PROJECT_CONFIG_FILENAME = ".kstonebase.json";

export type BindingSource = "argument" | "config-file" | "env" | "none";

export type BindingMode =
  | "workspace+product"
  | "workspace"
  | "product"
  | "discovery";

export interface ResolvedConfig {
  apiUrl: string;
  apiUrlSource: "argument" | "config-file" | "env" | "default";
  /** Personal Access Token. Required for everything except `--check --help`. */
  token: string | null;
  /** Resolved Workspace binding (file or env). Null when not bound. */
  workspaceId: string | null;
  workspaceSource: Exclude<BindingSource, "argument">;
  /** Resolved Product binding (file or env). Null when not bound. */
  productId: string | null;
  productSource: Exclude<BindingSource, "argument">;
  /** Effective binding mode derived from the (workspaceId, productId) pair. */
  bindingMode: BindingMode;
  /** Whether telemetry is allowed. Set to false when `KSTONEBASE_TELEMETRY=0`. */
  telemetryEnabled: boolean;
  /** When true, `apiUrl` may be plain HTTP. Off by default. */
  allowInsecure: boolean;
}

export interface ConfigOverrides {
  apiUrl?: string;
  /** Project root used to look for `.kstonebase.json`. Defaults to cwd. */
  cwd?: string;
  /** Test override — replaces process.env reads. */
  env?: NodeJS.ProcessEnv;
  /** Test override — read the config file off this map instead of disk. */
  fileReader?: (path: string) => string | null;
  allowInsecure?: boolean;
}

interface ProjectFileShape {
  apiUrl?: unknown;
  workspaceId?: unknown;
  productId?: unknown;
  defaultBranch?: unknown;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function parseProjectFile(
  cwd: string,
  fileReader: (path: string) => string | null,
): ProjectFileShape | null {
  const path = resolvePath(cwd, PROJECT_CONFIG_FILENAME);
  const raw = fileReader(path);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `${PROJECT_CONFIG_FILENAME} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ConfigError(
      `${PROJECT_CONFIG_FILENAME} must contain a JSON object.`,
    );
  }
  return parsed as ProjectFileShape;
}

function defaultFileReader(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function normalizeApiUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function resolveConfig(overrides: ConfigOverrides = {}): ResolvedConfig {
  const cwd = overrides.cwd ?? process.cwd();
  const env = overrides.env ?? process.env;
  const fileReader = overrides.fileReader ?? defaultFileReader;
  const file = parseProjectFile(cwd, fileReader);

  // workspaceId
  let workspaceId: string | null = null;
  let workspaceSource: ResolvedConfig["workspaceSource"] = "none";
  if (
    file &&
    typeof file.workspaceId === "string" &&
    file.workspaceId.length > 0
  ) {
    workspaceId = file.workspaceId;
    workspaceSource = "config-file";
  } else if (
    typeof env.KSTONEBASE_WORKSPACE_ID === "string" &&
    env.KSTONEBASE_WORKSPACE_ID.length > 0
  ) {
    workspaceId = env.KSTONEBASE_WORKSPACE_ID;
    workspaceSource = "env";
  }

  // productId
  let productId: string | null = null;
  let productSource: ResolvedConfig["productSource"] = "none";
  if (file && typeof file.productId === "string" && file.productId.length > 0) {
    productId = file.productId;
    productSource = "config-file";
  } else if (
    typeof env.KSTONEBASE_PRODUCT_ID === "string" &&
    env.KSTONEBASE_PRODUCT_ID.length > 0
  ) {
    productId = env.KSTONEBASE_PRODUCT_ID;
    productSource = "env";
  }

  // Phase 4 of the Workspaces epic: both ids are optional and the
  // server starts in discovery mode when both are absent. The previous
  // "productId required when the file is present" rule is removed; an
  // empty `{}` file just means "no binding".

  // apiUrl
  let apiUrl = DEFAULT_API_URL;
  let apiUrlSource: ResolvedConfig["apiUrlSource"] = "default";
  if (overrides.apiUrl) {
    apiUrl = overrides.apiUrl;
    apiUrlSource = "argument";
  } else if (file && typeof file.apiUrl === "string" && file.apiUrl.length > 0) {
    apiUrl = file.apiUrl;
    apiUrlSource = "config-file";
  } else if (
    typeof env.KSTONEBASE_API_URL === "string" &&
    env.KSTONEBASE_API_URL.length > 0
  ) {
    apiUrl = env.KSTONEBASE_API_URL;
    apiUrlSource = "env";
  }
  apiUrl = normalizeApiUrl(apiUrl);

  const allowInsecure = overrides.allowInsecure ?? false;
  if (!allowInsecure && !apiUrl.startsWith("https://") && !isLocalUrl(apiUrl)) {
    throw new ConfigError(
      `apiUrl "${apiUrl}" is not HTTPS. Pass --allow-insecure to opt in (intended for self-hosted dev only).`,
    );
  }

  // token
  const token =
    typeof env.KSTONEBASE_API_TOKEN === "string" &&
    env.KSTONEBASE_API_TOKEN.length > 0
      ? env.KSTONEBASE_API_TOKEN
      : null;

  // telemetry
  const telemetryEnabled = env.KSTONEBASE_TELEMETRY !== "0";

  const bindingMode: BindingMode =
    workspaceId && productId
      ? "workspace+product"
      : workspaceId
        ? "workspace"
        : productId
          ? "product"
          : "discovery";

  return {
    apiUrl,
    apiUrlSource,
    token,
    workspaceId,
    workspaceSource,
    productId,
    productSource,
    bindingMode,
    telemetryEnabled,
    allowInsecure,
  };
}

// Localhost / loopback URLs are commonly used during dev — let `http://localhost…`
// through without `--allow-insecure`. Anything else over HTTP needs the flag.
function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1"
    );
  } catch {
    return false;
  }
}
