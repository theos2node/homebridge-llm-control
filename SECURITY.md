# Security Policy

## Reporting a Vulnerability

If you believe you have found a security issue, please do **not** open a public GitHub issue.

Use this repository's private vulnerability reporting form. Do not include
credentials, bot tokens, webhook URLs, chat IDs, Homebridge PINs, or log
archives in a public issue.

Include:

- Plugin version (`homebridge-llm-control@x.y.z`)
- Homebridge + Node versions
- Messaging channel used (Telegram/ntfy/Discord)
- Impact and suggested remediation (if you have one)

## Notes

This plugin can be configured to execute allowlisted shell commands ("skills"). Treat access to the chat channel
as equivalent to privileged access to your Homebridge host.
