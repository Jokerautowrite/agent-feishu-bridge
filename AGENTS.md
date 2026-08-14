# AGENTS.md

This repository is the public, clean core for connecting local Codex to Feishu/Lark.

## Coding Behavior (Karpathy Four Principles)

These guidelines bias toward caution over speed. Use judgment for trivial tasks.

1. **Think before coding**: state assumptions; ask when uncertain; surface
   tradeoffs and simpler alternatives instead of silently picking one.
2. **Simplicity first**: minimum code that solves the problem. No speculative
   features, abstractions, or configurability nobody asked for.
3. **Surgical changes**: touch only what your change requires. Match existing
   style. Do not refactor unrelated code; mention dead code, do not delete it.
   Remove orphans your own change created.
4. **Goal-driven execution**: turn tasks into verifiable goals
   ("add validation" → "write tests for invalid inputs, then make them pass").
   Multi-step work gets a plan with per-step verify checks.

The test for every changed line: it should trace directly to the user request.

## Product Boundary

Keep this project focused on:

- Feishu/Lark bot connection.
- Local Codex app-server RPC.
- Workspace binding.
- Codex thread management.
- Model and reasoning effort selection.
- Approval cards.
- Sending files from a bound workspace to Feishu.
- Stable extension hooks for downstream private integrations.

Do not add private workflow features to this repository.

Out of scope:

- Private knowledge bases.
- Personal memory systems.
- Private task or note writeback.
- Personal activity ingestion.
- External agent orchestration.
- Organization-specific dashboards.
- Secrets, tokens, account IDs, logs, screenshots, chat transcripts, or local absolute paths from a real machine.

## Architecture Rule

Design every new capability as either public core or extension-facing surface:

- Public core: generic Feishu/Codex behavior that any user could need.
- Extension hook: a stable interface where private or organization-specific code can attach.
- Private extension: lives outside this repository.

If a feature requires private data, private paths, private automation, or a named personal workflow, keep it out of this repository and document only the generic hook it needs.

## Development

Before committing or publishing, run:

```sh
npm run check:release
```

If you add new source files, make sure they are included by the syntax check and privacy scan.

### Local development conventions

- Entry point is `bin/codex-im.js`; run locally with `npm run feishu-bot`.
- Layout: `src/app/` for bot/Feishu runtime and dispatch, `src/infra/` for
  per-backend RPC clients (codex / claude / opencode / chuang) and storage,
  `scripts/` for release checks and test harnesses.
- A new backend or extension should follow the existing RPC-client pattern under
  `src/infra/<backend>/` and be wired through `src/app/` config, not bolted on
  inside the Feishu runtime.
- Privacy is a release gate: `scripts/privacy-scan.js` must stay clean. Do not
  add real tokens, account IDs, absolute local paths, logs, or transcripts
  anywhere in the repository, including tests and fixtures.
- Feature work: keep generic Feishu/Codex behavior in this repo; anything
  private or machine-specific belongs behind an extension hook documented here.

### Testing

- Unit-style tests live in `scripts/test-*.js` and are wired into
  `npm run check:release`. Add a test for each new behavior area.
- After a change, run at least the targeted test plus `npm run check` before
  committing; run the full `check:release` before publish.
- Test real Feishu message flows against a throwaway dev app/bot, not the
  production bridge.

## Git Hygiene

- Commit source, docs, and examples.
- Do not commit `.env`, `node_modules`, generated tarballs, logs, runtime sessions, or local caches.
- Keep release artifacts reproducible with `npm pack`.
- Use small commits with clear messages.
