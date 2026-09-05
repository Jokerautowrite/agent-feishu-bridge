# Runtime safety and recovery

## Outgoing attachments

- Both the requested path and its resolved real path must stay inside the bound
  workspace. On Linux, the opened descriptor is checked as well, preventing a
  parent-directory symlink swap from bypassing the boundary.
- Credential-shaped files and directories are rejected even through aliases.
  These filename checks are defense in depth, **not content-level secret detection**.
- Optionally set `AGENT_BRIDGE_ATTACHMENT_EXPORT_DIR=deliverables`. Files then
  have to resolve inside that relative directory in **each** bound workspace.
  Absolute or escaping export-directory settings fail closed.
- Uploads are bounded reads from a verified regular-file descriptor. Failed
  uploads are not counted or remembered as successful; another directive can
  still succeed, and a failed directive can be retried.
- Missing files and transport errors are reported without exposing filesystem
  paths, credential values or transport payloads.

## Session state

- Existing unversioned session files remain supported. New writes use schema
  version 1, private temporary files, file/directory sync and atomic replacement.
- The previous valid state is retained as `.backup`. A corrupt primary can recover
  from this backup; before the next write its original bytes are retained in a
  uniquely named `.corrupt-*` file.
- Invalid state without a valid backup, unreadable files and unsupported future
  versions fail visibly rather than clearing bindings.
- A stale writer is rejected. **Run one bridge writer per session file**: this
  optimistic check is not a distributed or cross-process lock.
- Failed writes may leave private `.tmp-*` evidence. There is no automatic
  deletion of recovery artifacts. Review and authorize any retention cleanup
  separately.

## Timeouts

`AGENT_BRIDGE_CODEX_TURN_START_TIMEOUT_MS` controls acknowledgement of
`turn/start` and `turn/steer`, not total task execution. The default is 60 seconds,
and configuration is capped at five minutes. Long-running work instead uses the
separate `AGENT_BRIDGE_STALE_TURN_TIMEOUT_MS` progress watchdog.
That watchdog measures inactivity since the latest item/tool/content/plan event,
not total task age. Status heartbeats and token counters do not extend the timer.
A silent long-running tool can still exceed it; choose the inactivity threshold
for the expected workload. Recovery releases bridge state, not the backend task.

If acknowledgement times out, it does not prove the backend never started a
task. Reconcile the active thread before retrying; avoid duplicate paid work.

## Logs and privacy

The entrypoint redacts known credential environment values and common credential
fields from console and fatal diagnostics. Invalid RPC payloads are logged by
byte count, not with raw contents. The release privacy scanner reports only the
rule and location, never the matching credential.

This protects bridge diagnostics, **not a backend's own SQLite database or log
files**. Audit those separately. Avoid inline credentials in model-visible config;
use a supported environment or command-backed credential reference instead.
Redaction cannot guarantee arbitrary private document content is safe to publish.

## Verification and rollout

```sh
npm run test:server-hardening
npm run test:groups
npm run check:release
```

Tests use synthetic temporary fixtures and mocked uploads. They do not use a
production bot or make paid model calls. Fixtures are retained for inspection.

Stage and verify before touching a live bridge. Preserve local backend adapters,
private env/session files and unrelated edits. An active bridge usually keeps
modules/configuration loaded until a restart; a successful Git push does not
prove live activation. Drain active work, reload one instance at a time, and
verify the new process plus message delivery. Never interrupt the active task
that is delivering the rollout report.

Pulling a Git update on another machine updates source only. Do not copy server
credentials, private memory, session bindings, runtime paths or supervision
settings onto a desktop machine.
