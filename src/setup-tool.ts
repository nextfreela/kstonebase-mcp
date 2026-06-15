import type { KstonebaseClient } from "./client.js";
import { McpToolError } from "./errors.js";
import {
  renderAgentDocs,
  type AgentDocsBinding,
  type SpecManagementType,
} from "./templates/agent-docs.js";

export type TransportKind = "stdio" | "http" | "remote-endpoint";

export type InitScope = "workspace" | "product";

export interface InitArgs {
  workspaceId?: string;
  productId?: string;
  targetDir?: string;
  includeAgentDocs?: boolean;
  force?: boolean;
  existingFiles?: string[];
  existingKstonebaseJson?: string;
}

export interface InitDeps {
  client: KstonebaseClient;
  cwd: string;
  transport: TransportKind;
  boundWorkspaceId?: string | null;
  boundProductId?: string | null;
}

export type FileAction = "create" | "skip" | "conflict" | "overwrite";

export interface FilePlanEntry {
  path: string;
  content: string;
  alreadyExists: boolean;
  action: FileAction;
}

export interface PlannedResult {
  status: "planned";
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

export interface WorkspaceCandidate {
  id: string;
  name: string | null;
}

export interface ProductCandidate {
  id: string;
  name: string | null;
  specificationManagementType: SpecManagementType | null;
}

export interface NeedsSelectionResult {
  status: "needs_selection";
  scope: InitScope;
  summary: string;
  candidates: WorkspaceCandidate[] | ProductCandidate[];
  nextStep: string;
}

export type InitResult = PlannedResult | NeedsSelectionResult;

const KSTONEBASE_JSON_PATH = ".kstonebase.json";
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

export async function runInitWorkspace(
  args: InitArgs,
  deps: InitDeps,
): Promise<InitResult> {
  const effectiveWorkspaceId = resolveEffectiveId(
    "workspaceId",
    args.workspaceId,
    args.existingKstonebaseJson,
    deps.boundWorkspaceId,
  );

  if (!effectiveWorkspaceId) {
    const candidates = await listWorkspaceCandidates(deps.client);
    return {
      status: "needs_selection",
      scope: "workspace",
      summary:
        "No workspace is bound to this directory yet. Ask the user which workspace to bind, then call init_workspace again with the chosen workspaceId.",
      candidates,
      nextStep:
        "Present these workspaces to the user, then call init_workspace again with the chosen workspaceId.",
    };
  }

  const workspace = await fetchWorkspace(deps.client, effectiveWorkspaceId);
  const binding: AgentDocsBinding = {
    productId: null,
    productName: null,
    productType: null,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
  };
  return buildPlanned(binding, args, deps);
}

export async function runInitProduct(
  args: InitArgs,
  deps: InitDeps,
): Promise<InitResult> {
  const effectiveProductId = resolveEffectiveId(
    "productId",
    args.productId,
    args.existingKstonebaseJson,
    deps.boundProductId,
  );

  if (!effectiveProductId) {
    const workspaceScope = resolveEffectiveId(
      "workspaceId",
      args.workspaceId,
      args.existingKstonebaseJson,
      deps.boundWorkspaceId,
    );
    const candidates = await listProductCandidates(deps.client, workspaceScope);
    const scoped = workspaceScope ? ` in workspace ${workspaceScope}` : "";
    return {
      status: "needs_selection",
      scope: "product",
      summary: `No product is bound to this directory yet. Ask the user which product to bind${scoped}, then call init_product again with the chosen productId.`,
      candidates,
      nextStep:
        "Present these products to the user, then call init_product again with the chosen productId. You may pass a workspaceId (discover it with list_workspaces) to scope the product list.",
    };
  }

  const product = await fetchProduct(deps.client, effectiveProductId);

  if (
    typeof args.workspaceId === "string" &&
    args.workspaceId.length > 0 &&
    product.workspaceId &&
    args.workspaceId !== product.workspaceId
  ) {
    throw new McpToolError(
      "VALIDATION_ERROR",
      `Product "${product.name}" (${product.id}) is not in workspace ${args.workspaceId}; it belongs to ${product.workspaceId}.`,
      "Pass the product's own workspace, or omit workspaceId to bind the product on its own.",
    );
  }

  const workspaceId = product.workspaceId ?? args.workspaceId ?? null;
  const workspaceName = workspaceId
    ? await fetchWorkspaceNameBestEffort(deps.client, workspaceId)
    : null;

  const binding: AgentDocsBinding = {
    productId: product.id,
    productName: product.name,
    productType: product.type,
    workspaceId,
    workspaceName,
  };
  return buildPlanned(binding, args, deps);
}

function buildPlanned(
  binding: AgentDocsBinding,
  args: InitArgs,
  deps: InitDeps,
): PlannedResult {
  const includeAgentDocs = args.includeAgentDocs !== false;
  const force = args.force === true;
  const existingFiles = new Set(args.existingFiles ?? []);
  const targetDir = args.targetDir ?? deps.cwd;

  const kstonebaseJsonContent = renderKstonebaseJson(binding);
  const agentDocsContent = includeAgentDocs ? renderAgentDocs(binding) : null;

  const files: FilePlanEntry[] = [];

  files.push(
    resolveKstonebaseJsonEntry({
      desiredContent: kstonebaseJsonContent,
      existingRaw: args.existingKstonebaseJson,
      isPresent:
        existingFiles.has(KSTONEBASE_JSON_PATH) ||
        typeof args.existingKstonebaseJson === "string",
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
    status: "planned",
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

function resolveEffectiveId(
  key: "workspaceId" | "productId",
  explicit: string | undefined,
  existingRaw: string | undefined,
  bound: string | null | undefined,
): string | null {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const fromFile = parseBindingId(existingRaw, key);
  if (fromFile) return fromFile;
  if (typeof bound === "string" && bound.length > 0) return bound;
  return null;
}

function parseBindingId(
  raw: string | undefined,
  key: "workspaceId" | "productId",
): string | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const v = parsed[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function renderKstonebaseJson(binding: AgentDocsBinding): string {
  const out: Record<string, string> = {};
  if (binding.workspaceId) out.workspaceId = binding.workspaceId;
  if (binding.productId) out.productId = binding.productId;
  return JSON.stringify(out, null, 2) + "\n";
}

interface KstonebaseJsonResolveArgs {
  desiredContent: string;
  existingRaw: string | undefined;
  isPresent: boolean;
  force: boolean;
}

function resolveKstonebaseJsonEntry(
  args: KstonebaseJsonResolveArgs,
): FilePlanEntry {
  const base: FilePlanEntry = {
    path: KSTONEBASE_JSON_PATH,
    content: args.desiredContent,
    alreadyExists: args.isPresent,
    action: "create",
  };

  if (args.force) {
    base.action = args.isPresent ? "overwrite" : "create";
    return base;
  }

  if (!args.isPresent) {
    base.action = "create";
    return base;
  }

  if (typeof args.existingRaw === "string") {
    const sameIds = compareKstonebaseJsonIds(
      args.existingRaw,
      args.desiredContent,
    );
    base.action = sameIds === "match" ? "skip" : "conflict";
    return base;
  }

  base.action = "conflict";
  return base;
}

type KstonebaseJsonCompare = "match" | "differ" | "unparseable";

function compareKstonebaseJsonIds(
  rawExisting: string,
  desired: string,
): KstonebaseJsonCompare {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
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
  return "Bind this directory to Kstonebase.";
}

function renderNextStep(
  transport: TransportKind,
  files: FilePlanEntry[],
): string {
  const conflict = files.some((f) => f.action === "conflict");
  if (conflict) {
    return "One or more files conflict with existing local content. Surface the diff to the user before re-invoking with force=true.";
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
  client: KstonebaseClient,
  workspaceId: string,
): Promise<WorkspaceLookup> {
  const res = await client.readWorkspace(workspaceId);
  const name = pickString(res.body, "name") ?? workspaceId;
  return { id: workspaceId, name };
}

async function fetchWorkspaceNameBestEffort(
  client: KstonebaseClient,
  workspaceId: string,
): Promise<string | null> {
  try {
    return (await fetchWorkspace(client, workspaceId)).name;
  } catch {
    return null;
  }
}

async function fetchProduct(
  client: KstonebaseClient,
  productId: string,
): Promise<ProductLookup> {
  const res = await client.readProduct(productId);
  const name = pickString(res.body, "name") ?? productId;
  const type = normalizeType(
    pickString(res.body, "specificationManagementType"),
  );
  const workspaceId = pickString(res.body, "workspaceId");
  return { id: productId, name, type: type ?? "free", workspaceId };
}

async function listWorkspaceCandidates(
  client: KstonebaseClient,
): Promise<WorkspaceCandidate[]> {
  const res = await client.listWorkspaces();
  return extractItems(res.body)
    .map((w) => ({ id: pickString(w, "id") ?? "", name: pickString(w, "name") }))
    .filter((c) => c.id.length > 0);
}

async function listProductCandidates(
  client: KstonebaseClient,
  workspaceId: string | null,
): Promise<ProductCandidate[]> {
  const res = workspaceId
    ? await client.listProducts({ workspaceId })
    : await client.listProducts({ orphan: true });
  return extractItems(res.body)
    .map((p) => ({
      id: pickString(p, "id") ?? "",
      name: pickString(p, "name"),
      specificationManagementType: normalizeType(
        pickString(p, "specificationManagementType"),
      ),
    }))
    .filter((c) => c.id.length > 0);
}

function extractItems(body: unknown): Record<string, unknown>[] {
  if (!isPlainObject(body)) return [];
  const items = body.items;
  if (!Array.isArray(items)) return [];
  return items.filter(isPlainObject);
}

function normalizeType(raw: string | null): SpecManagementType | null {
  if (raw === "free") return "free";
  if (raw === "web_application") return "web_application";
  return null;
}

function pickString(body: unknown, key: string): string | null {
  if (!isPlainObject(body)) return null;
  const v = body[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}
