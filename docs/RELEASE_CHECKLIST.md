# Release Checklist

Use this before publishing a package or pushing a public GitHub release.

## Required Checks

```sh
npm run check:release
```

This runs:

- JavaScript syntax checks.
- Privacy scan.
- Production dependency audit.
- `npm pack --dry-run`.

## Manual Review

- Confirm `README.md` and `docs/使用说明.md` match current behavior.
- Confirm `.env.example` contains placeholders only.
- Confirm no `.env`, logs, sessions, screenshots, local caches, or generated tarballs are committed.
- Confirm `package.json` repository metadata is set only after the real GitHub repository exists.
- Confirm private extensions are not included in this repository.

## Versioning

Before a public release:

1. Update `package.json` version.
2. Run `npm run check:release`.
3. Commit with a release-oriented message.
4. Tag the release, for example `v0.1.0`.
5. Push the branch and tag.

