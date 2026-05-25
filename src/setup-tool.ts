// `init_local_binding` tool body (per Xpec MCP spec "mcp-setup-tools").
// Composes the existing read_workspace / read_product handlers to validate
// the requested binding, then returns a structured file plan the agent
// applies with its own file-write tool. This module performs zero
// filesystem I/O — the file plan is data, not side effects.

import type { XpecClient } from "./client.js";
import { McpToolError } from "./errors.js";
import {
  renderAgentDocs,
  type AgentDocsBinding,
  type SpecManagementType,
} from "./templates/agent-docs.js";

export type TransportKind = "stdio" | "http" | "remote-endpoint";

export interface InitLocalBindingArgs {
  workspaceId?: string;
  productId?: string;
  targetDir?: string;
  includeAgentDocs?: boolean;
  force?: boolean;
  existingFiles?: string[];
  existingXpecJson?: string;
}

export interface InitLocalBindingDeps {
  client: XpecClient;
  cwd: string;
  transport: TransportKind;
}

export type FileAction = "create" | "skip" | "conflict" | "overwrite";

export interface FilePlanEntry {
  path: string;
  content: string;
  alreadyExists: boolean;
  action: FileAction;
}

export interface InitLocalBindingResult {
  summary: string;
  binding: {
    workspaceId: string | null;
    workspaceName: string | null;
    productId: string | null;
    productName: string | null;
    productType: SpecManagementType | null;
  };
  targetDir: string;
  files: FilePlanEntry[];
  nextStep: string;
}

const XPEC_JSON_PATH = ".xpec.json";
const CLAUDE_MD_PATH = "CLAUDE.md";
const AGENTS_MD_PATH = "AGENTS.md";

interface WorkspaceLookup {
  id: string;
  name: string;
}

interface ProductLookup {
  id: string;
  name: string;
  type: SpecManagementType;
  workspaceId: string | null;
}

export async function runInitLocalBinding(
  args: InitLocalBindingArgs,
  deps: InitLocalBindingDeps,
): Promise<InitLocalBindingResult> {
  const hasWorkspaceId =
    typeof args.workspaceId === "string" && args.workspaceId.length > 0;
  const hasProductId =
    typeof args.productId === "string" && args.productId.length > 0;

  if (!hasWorkspaceId && !hasProductId) {
    throw new McpToolError(
      "VALIDATION_ERROR",
      "init_local_binding requires at least one of `workspaceId` or `productId`.",
      "Pass workspaceId, productId, or both. Discover ids with list_workspaces / list_products / find_product_by_subject first.",
    );
  }

  const workspace = hasWorkspaceId
    ? await fetchWorkspace(deps.client, args.workspaceId as string)
    : null;
  const product = hasProductId
    ? await fetchProduct(deps.client, args.productId as string)
    : null;

  if (workspace && product) {
    if (product.workspaceId !== workspace.id) {
      throw new McpToolError(
        "VALIDATION_ERROR",
        `Product "${product.name}" (${product.id}) is not in workspace "${workspace.name}" (${workspace.id}).`,
        "Pass a workspaceId that owns this product, or omit workspaceId to bind the product on its own.",
      );
    }
  }

  const binding: AgentDocsBinding = {
    productId: product?.id ?? null,
    productName: product?.name ?? null,
    productType: product?.type ?? null,
    workspaceId: workspace?.id ?? null,
    workspaceName: workspace?.name ?? null,
  };

  const includeAgentDocs = args.includeAgentDocs !== false;
  const force = args.force === true;
  const existingFiles = new Set(args.existingFiles ?? []);

  const targetDir = args.targetDir ?? deps.cwd;

  const xpecJsonContent = renderXpecJson(binding);
  const agentDocsContent = includeAgentDocs ? renderAgentDocs(binding) : null;

  const files: FilePlanEntry[] = [];

  files.push(
    resolveXpecJsonEntry({
      desiredContent: xpecJsonContent,
      existingRaw: args.existingXpecJson,
      isPresent:
        existingFiles.has(XPEC_JSON_PATH) ||
        typeof args.existingXpecJson === "string",
      force,
    }),
  );

  if (agentDocsContent !== null) {
    files.push(
      resolveTemplateEntry({
        path: CLAUDE_MD_PATH,
        desiredContent: agentDocsContent,
        isPresent: existingFiles.has(CLAUDE_MD_PATH),
        force,
      }),
    );
    files.push(
      resolveTemplateEntry({
        path: AGENTS_MD_PATH,
        desiredContent: agentDocsContent,
        isPresent: existingFiles.has(AGENTS_MD_PATH),
        force,
      }),
    );
  }

  return {
    summary: renderSummary(binding),
    binding: {
      workspaceId: binding.workspaceId,
      workspaceName: binding.workspaceName,
      productId: binding.productId,
      productName: binding.productName,
      productType: binding.productType,
    },
    targetDir,
    files,
    nextStep: renderNextStep(deps.transport, files),
  };
}

/**
 * Canonical `.xpec.json` content per Xpec MCP spec "mcp-workspace-tools" §4:
 * two-space indentation, keys in the order workspaceId → productId, trailing
 * newline. Only the keys that were provided are emitted. `apiUrl` is
 * intentionally never emitted by this tool (per the setup spec §6).
 */
export function renderXpecJson(binding: AgentDocsBinding): string {
  const out: Record<string, string> = {};
  if (binding.workspaceId) out.workspaceId = binding.workspaceId;
  if (binding.productId) out.productId = binding.productId;
  return JSON.stringify(out, null, 2) + "\n";
}

interface XpecJsonResolveArgs {
  desiredContent: string;
  existingRaw: string | undefined;
  isPresent: boolean;
  force: boolean;
}

function resolveXpecJsonEntry(args: XpecJsonResolveArgs): FilePlanEntry {
  const base: FilePlanEntry = {
    path: XPEC_JSON_PATH,
    content: args.desiredContent,
    alreadyExists: args.isPresent,
    action: "create",
  };

  if (args.force) {
    if (args.isPresent) {
      base.action = "overwrite";
    } else {
      base.action = "create";
    }
    return base;
  }

  if (!args.isPresent) {
    base.action = "create";
    return base;
  }

  // File is present, force is false. Compare existing vs desired.
  if (typeof args.existingRaw === "string") {
    const sameIds = compareXpecJsonIds(args.existingRaw, args.desiredContent);
    base.action = sameIds === "match" ? "skip" : "conflict";
    return base;
  }

  // Marked as present in existingFiles but raw content wasn't supplied — we
  // can't tell if the ids match. Treat as conflict so the agent surfaces the
  // ambiguity rather than overwriting silently.
  base.action = "conflict";
  return base;
}

type XpecJsonCompare = "match" | "differ" | "unparseable";

function compareXpecJsonIds(
  rawExisting: string,
  desired: string,
): XpecJsonCompare {
  let existing: unknown;
  try {
    existing = JSON.parse(rawExisting);
  } catch {
    return "unparseable";
  }
  let want: unknown;
  try {
    want = JSON.parse(desired);
  } catch {
    return "unparseable";
  }
  if (!isPlainObject(existing) || !isPlainObject(want)) return "unparseable";
  return existing.workspaceId === want.workspaceId &&
    existing.productId === want.productId
    ? "match"
    : "differ";
}

function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface TemplateResolveArgs {
  path: string;
  desiredContent: string;
  isPresent: boolean;
  force: boolean;
}

function resolveTemplateEntry(args: TemplateResolveArgs): FilePlanEntry {
  const action: FileAction = args.force
    ? args.isPresent
      ? "overwrite"
      : "create"
    : args.isPresent
      ? "skip"
      : "create";
  return {
    path: args.path,
    content: args.desiredContent,
    alreadyExists: args.isPresent,
    action,
  };
}

function renderSummary(binding: AgentDocsBinding): string {
  if (binding.productName && binding.workspaceName) {
    return `Bind this directory to product "${binding.productName}" inside workspace "${binding.workspaceName}".`;
  }
  if (binding.productName) {
    return `Bind this directory to product "${binding.productName}".`;
  }
  if (binding.workspaceName) {
    return `Bind this directory to workspace "${binding.workspaceName}".`;
  }
  return "Bind this directory to Xpec.";
}

function renderNextStep(
  transport: TransportKind,
  files: FilePlanEntry[],
): string {
  const conflict = files.some((f) => f.action === "conflict");
  if (conflict) {
    return "One or more files conflict with existing local content. Surface the diff to the user before re-invoking init_local_binding with force=true.";
  }
  const allSkipped = files.every((f) => f.action === "skip");
  if (allSkipped) {
    return "Every file is already in place. No write is required.";
  }
  if (transport === "remote-endpoint") {
    return "Apply the file plan above with your file-write tool. The binding takes effect on the next tool call.";
  }
  return "Apply the file plan above with your file-write tool, then restart your MCP client so it picks up the new binding.";
}

async function fetchWorkspace(
  client: XpecClient,
  workspaceId: string,
): Promise<WorkspaceLookup> {
  const res = await client.readWorkspace(workspaceId);
  const name = pickString(res.body, "name") ?? workspaceId;
  return { id: workspaceId, name };
}

async function fetchProduct(
  client: XpecClient,
  productId: string,
): Promise<ProductLookup> {
  const res = await client.readProduct(productId);
  const name = pickString(res.body, "name") ?? productId;
  const rawType =
    pickString(res.body, "specificationManagementType") ?? "free";
  const type: SpecManagementType =
    rawType === "web_application" ? "web_application" : "free";
  const workspaceId = pickString(res.body, "workspaceId") ?? null;
  return { id: productId, name, type, workspaceId };
}

function pickString(body: unknown, key: string): string | null {
  if (!isPlainObject(body)) return null;
  const v = body[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}
