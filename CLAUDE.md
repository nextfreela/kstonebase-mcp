# CLAUDE.md

Guidance for Claude Code when working in this repository. Mirrors `AGENTS.md`;
update both files together if either changes.

## Kstonebase-First Rule

This repository is spec-driven. Before writing or updating code, planning a
feature, or making an architectural decision, use the **Kstonebase MCP server** to
find and read the relevant Kstonebase specs. Treat Kstonebase as the
source of truth.

- Never call the Kstonebase HTTP API directly. The Kstonebase MCP tools
  are the only sanctioned interface to the platform.
- This repo is already bound through `.kstonebase.json`; use that default
  binding unless the user explicitly asks you to target a different Workspace
  or Product.
- Do not rely on stale repo docs, memory, or inferred behavior when a current
  spec is available.
- Do not duplicate authoritative spec content into this repo unless the user
  explicitly asks for a local copy.

## Required Workflow (read before any code change)

1. Identify the relevant spec with `search_specifications` or
   `list_specifications`.
2. Read the current spec with `read_specification`.
3. Check unresolved questions and assumptions with `list_open_questions`.
4. If older decisions matter, inspect history with
   `list_specification_versions` and `read_specification_version`.
5. Only then plan the implementation and update the code.

If you skip step 1–4 because "the change looks small," stop and run them
anyway. The cost of reading the spec is lower than the cost of shipping code
that contradicts it.

## When the Spec Is Wrong or Incomplete

If the spec is missing details, incorrect, or out of sync with the requested
change, update the spec **before** implementing:

1. If no spec exists and the bound product supports it, create one with
   `create_free_specification`.
2. Otherwise open a draft with `start_new_version`.
3. Prefer `update_specification_section` for targeted edits.
4. Use `update_specification_content` when a larger rewrite is needed.
5. Surface or resolve open questions before advancing.
6. Send the draft for human approval with `request_review`.

Never pretend a spec is approved. Only a human marks a spec Reviewed in
Kstonebase — do not claim a draft is "done" or implement against an
unreviewed draft as if it were authoritative.

## Development Expectations

- Implement code against the current Kstonebase spec, not against ad hoc
  repo notes or assumptions.
- If implementation uncovers a spec gap, pause and update the spec first
  rather than improvising in code.
- Keep tests and behavior aligned with the spec's contracts, statuses, and
  terminology — reuse the spec's exact names rather than inventing parallel
  vocabulary.
- In summaries, plans, and PR descriptions, reference the relevant spec or
  section (link or identifier) instead of copying large spec excerpts into
  the repository.

## Failure Mode

If Kstonebase MCP access is unavailable:

- Do not guess on feature behavior or architectural intent.
- Do not fall back to "what the code currently does" as a substitute for the
  spec.
- Ask the user to restore MCP access or to paste the relevant spec details
  before making substantive changes.

Trivial, spec-irrelevant work (typo fixes, formatting, dependency bumps with
no behavior change) may proceed without spec access — but say so explicitly.
