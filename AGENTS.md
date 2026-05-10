# AGENTS.md

## Xpecification-First Rule

This repository is spec-driven. Before writing or updating code, planning a
feature, or making an architectural choice, use the `xpecification` MCP to
find and read the relevant Xpecification specs. Treat Xpecification as the
source of truth.

Never call the Xpecification HTTP API directly from agent workflows. Always use
the Xpecification MCP tools as the only interface to the Xpecification
platform.

This repo is already bound through `.xpecification.json`; use that default
binding unless the user explicitly asks you to work against a different
Workspace or Product.

Do not rely on stale repo docs, memory, or inferred behavior when a current
spec is available. Do not duplicate authoritative spec content into this repo
unless the user explicitly asks for a local copy.

## Required Workflow

1. Identify the relevant spec with `search_specifications` or
   `list_specifications`.
2. Read the current spec with `read_specification`.
3. Check unresolved questions and assumptions with `list_open_questions`.
4. If older decisions matter, inspect history with
   `list_specification_versions` and `read_specification_version`.
5. Only then plan the implementation and update the code.

## When the Spec Is Wrong or Incomplete

If the spec is missing details, incorrect, or out of sync with the requested
change, update the spec before implementing:

1. If no spec exists and the bound product supports it, create one with
   `create_free_specification`.
2. Otherwise open a draft with `start_new_version`.
3. Prefer `update_specification_section` for targeted edits.
4. Use `update_specification_content` when a larger rewrite is needed.
5. Surface or resolve open questions before advancing.
6. Send the draft for human approval with `request_review`.

Agents must never pretend a spec is approved. Only a human marks a spec
Reviewed in Xpecification.

## Development Expectations

- Implement code against the current Xpecification spec, not against ad hoc
  repo notes.
- If implementation uncovers a spec gap, pause and update the spec first.
- Keep tests and behavior aligned with the spec's contracts, statuses, and
  terminology.
- In summaries, plans, and reviews, reference the relevant spec or section
  instead of copying large spec excerpts into the repository.

## Failure Mode

If Xpecification MCP access is unavailable, do not guess on feature behavior or
architectural intent. Ask for access to be restored or for the relevant spec
details before making substantive changes.
