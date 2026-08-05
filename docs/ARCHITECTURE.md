# Architecture

`codex-feishu-bridge` is the public core for one job:

```text
Feishu/Lark message -> local Codex app-server -> Feishu/Lark response
```

## Layers

```text
bin/
  CLI entrypoint

src/app/
  Runtime orchestration and command dispatch

src/domain/
  Workspace, thread, attachment, approval, and session behavior

src/infra/
  Feishu SDK adapter, Codex RPC client, config, storage

src/presentation/
  Feishu card and message rendering

src/shared/
  Small shared parsing and formatting helpers
```

## Public Core vs Private Extensions

The public core should stay clean and reusable. Private or organization-specific capabilities should attach through stable extension points instead of being added directly to core.

Examples of public core:

- Receive Feishu messages.
- Send replies and cards.
- Bind a Feishu conversation to a local workspace.
- Start or reuse Codex threads.
- Approve or reject Codex actions.
- Download Feishu/Lark images and pass them to Codex as localImage inputs.
- Upload current-workspace images or files back to Feishu/Lark.

Examples of private extensions:

- Personal memory recall.
- Private task or note writeback.
- Personal activity summary sync.
- External agent orchestration.
- Organization-specific dashboards.

## Extension Direction

Future extension points should prefer explicit hooks:

```text
beforeMessage(context)
afterCodexReply(context)
onCommand(command, context)
onApprovalRequest(request, context)
onUsageUpdate(usage, context)
```

Hooks must receive structured context and return structured results. They must not require private paths, private tokens, or private platform assumptions in the public core.
