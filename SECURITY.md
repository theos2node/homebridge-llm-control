# Security Policy

## Reporting a Vulnerability

If you believe you have found a security issue, please do **not** open a public GitHub issue.

Instead:

1. Create a private report via GitHub Security Advisories (preferred), or
2. Email the maintainer with details and reproduction steps.

Include:

- Plugin version (`homebridge-llm-control@x.y.z`)
- Homebridge + Node versions
- Messaging channel used (Telegram/ntfy/Discord)
- Impact and suggested remediation (if you have one)

## Notes

This plugin can be configured to execute allowlisted shell commands ("skills"). Treat access to the chat channel
as equivalent to privileged access to your Homebridge host.

