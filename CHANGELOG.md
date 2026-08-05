# Changelog

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
