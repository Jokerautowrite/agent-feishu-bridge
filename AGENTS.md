# AGENTS.md

This repository is the public, clean core for connecting local Codex to Feishu/Lark.

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

## Git Hygiene

- Commit source, docs, and examples.
- Do not commit `.env`, `node_modules`, generated tarballs, logs, runtime sessions, or local caches.
- Keep release artifacts reproducible with `npm pack`.
- Use small commits with clear messages.
