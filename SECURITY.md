# Security Policy

## Supported Versions

This project is pre-1.0. Security fixes target the latest published version.

## Reporting a Vulnerability

Please report vulnerabilities privately to the repository maintainers once a public GitHub repository exists. Do not open a public issue with exploit details, secrets, tokens, or private logs.

## Sensitive Data Rules

Never commit:

- `.env` files.
- API keys, app secrets, access tokens, OAuth tokens, or session cookies.
- Real Feishu open IDs, chat IDs, tenant IDs, or document tokens unless they are clearly public examples.
- Local absolute paths from a real user's machine.
- Logs, screenshots, chat transcripts, or private workspace data.

Use `.env.example` for placeholders only.

