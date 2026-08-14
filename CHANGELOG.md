# Changelog

## Unreleased

### Added

- Added a native Gemini CLI backend using the official headless `stream-json` protocol, including streaming replies, tool events, token usage, session resume, interruption, attachments-as-local-path context, and Windows command-shim support.
- Added contract tests for the Gemini adapter and card-action authorization.

### Security

- Reject outbound workspace files and workspace allowlist entries whose real path escapes through a symlink or junction.
- Restrict group-card actions to recorded or configured administrators when no explicit sender allowlist is configured.
- Enforce read-only mode and the hard safety guard for every non-admin group member, including mention-exempt groups.
- Fail closed when mention-only mode cannot resolve the bot identity.

### Verification

- Added all group authorization suites and the new security suites to `npm run check:release`.

## v0.2.4 - 2026-05-12

### Added

- Added Feishu/Lark image intake: image and rich post image resources are downloaded to a local private cache and passed to Codex as native `localImage` input.
- Added outbound attachment directives with `[[codex-feishu-send:relative/path]]` so Codex can send current-workspace images and files back to Feishu/Lark.
- Added media and outbound directive regression fixtures.

### Changed

- Documented attachment cache configuration and media behavior in README and the Chinese usage guide.
- Updated `protobufjs` transitive dependencies in the lockfile through `npm audit fix`.

### Verification

- `npm run check:release` passed locally.
- Privacy scan passed; no private runtime extensions, local workspace paths, secrets, logs, or personal automation code are included.

## v0.2.3 - 2026-04-29

### Changed

- Improved Feishu/Lark streaming card rendering for completed replies.
- Separated final answer content from execution/process content so card bodies stay easier to read.
- Added generic attachment routing for `/codex send`: images are sent as image messages, supported audio as audio messages, and other files as file messages.

### Added

- Added public card-content regression tests for completed reply rendering.
- Added assistant Markdown regression tests for lists, code blocks, inline code, and paragraph handling.
- Added release-time verification through `npm run check:release`.

### Verification

- `npm run check:release` passed locally.
- GitHub Actions passed for commit `c8a9c6d`.
- Privacy scan passed; this public release does not include private runtime extensions, local workspace paths, personal memory bridges, or private automation code.
