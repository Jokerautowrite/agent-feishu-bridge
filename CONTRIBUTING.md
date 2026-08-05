# Contributing

Thanks for helping improve `codex-feishu-bridge`.

## Scope

This project is intentionally narrow: it connects Feishu/Lark to a local Codex app-server. Please keep changes generic and reusable.

Good contributions:

- Feishu/Lark message handling.
- Codex RPC stability.
- Workspace and thread management.
- Approval and card rendering improvements.
- Documentation, examples, tests, and release checks.
- Extension hooks for downstream integrations.

Not accepted in the public core:

- Private knowledge-base integrations.
- Personal automation workflows.
- Hard-coded local paths, organization names, user IDs, or bot IDs.
- Secrets, tokens, logs, chat transcripts, screenshots, or account data.

## Local Checks

Run before opening a pull request:

```sh
npm install
npm run check:release
```

## Pull Requests

Please include:

- What changed.
- Why it changed.
- How you tested it.
- Any compatibility notes.

Keep PRs focused. If a change mixes public core work and private integration work, split it and only submit the public core portion here.

