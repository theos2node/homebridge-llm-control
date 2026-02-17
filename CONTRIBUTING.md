# Contributing

Thanks for contributing to `homebridge-llm-control`.

## Local Setup

Requirements:

- Node.js 20+ recommended
- npm

Commands:

```bash
npm install
npm test
npm run lint
npm run build
```

## Development Notes

- This plugin is a Homebridge **platform** plugin.
- The chat UX is intentionally kept simple (text commands first).
- Accessory control uses Homebridge's local HAP HTTP endpoints (requires Homebridge to run with insecure requests enabled, typically via `-I`).
- Be careful with any feature that executes shell commands. Anything that can run commands must be:
  - allowlisted,
  - rate-limited (cooldown),
  - quota-limited (daily),
  - explicit about user authorization.

## Pull Requests

Please include:

- What you changed and why
- How you tested it (Homebridge + Node version)
- Any config changes (update `config.schema.json` and `README.md` if needed)

## Releases

Project uses npm publishing for Homebridge Store distribution:

1. Bump `package.json` version (and `package-lock.json`)
2. `npm run build && npm test`
3. Tag the release: `git tag vX.Y.Z`
4. Push: `git push origin main --tags`
5. Publish: `npm publish --access public`

