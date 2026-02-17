# homebridge-llm-control

LLM-powered operations plugin for Homebridge with:

- LLM provider presets (`OpenAI` + custom OpenAI-compatible endpoint)
- Telegram onboarding + chat control
- Daily health monitoring
- Watchdog checks for critical signals
- Guardrailed self-healing commands (allowlist + cooldown + daily quota)
- Config-based and chat-created scheduled automations

## Homebridge Store readiness

This package is Homebridge store compatible when published to npm:

- package name starts with `homebridge-`
- includes keyword `homebridge-plugin`
- includes `config.schema.json`
- declares Homebridge platform metadata in `package.json`

## Installation

After publishing:

```bash
npm install -g homebridge-llm-control
```

Or use Homebridge UI search for `homebridge-llm-control`.

## Configuration

Use Homebridge UI plugin settings (recommended) or `config.json`.

### Example config

```json
{
  "platform": "LLMControl",
  "name": "LLM Control",
  "provider": {
    "preset": "openai",
    "apiKey": "sk-...",
    "model": "gpt-4.1-mini",
    "temperature": 0.2,
    "maxTokens": 600,
    "requestTimeoutMs": 30000
  },
  "messaging": {
    "enabled": true,
    "botToken": "123456789:AA...",
    "pollIntervalMs": 2000
  },
  "monitoring": {
    "dailyMonitoringEnabled": true,
    "dailyMonitoringTime": "09:00",
    "timezone": "America/New_York",
    "includeLogs": true,
    "logFilePath": "/var/lib/homebridge/homebridge.log",
    "maxLogLines": 300
  },
  "watchdog": {
    "enabled": true,
    "checkIntervalMinutes": 10,
    "criticalPatterns": ["FATAL", "UnhandledPromiseRejection", "out of memory"],
    "autoTriggerOnCritical": true
  },
  "selfHealing": {
    "enabled": true,
    "maxActionsPerDay": 5,
    "commands": [
      {
        "id": "restart-homebridge",
        "label": "Restart Homebridge",
        "command": "sudo systemctl restart homebridge",
        "cooldownMinutes": 60
      }
    ]
  },
  "automations": [
    {
      "id": "daily-check",
      "name": "Morning Check",
      "scheduleCron": "0 8 * * *",
      "prompt": "Review health and summarize any actions needed.",
      "enabled": true
    }
  ]
}
```

## Telegram onboarding flow

1. Create a bot with BotFather and copy the bot token.
2. Add token in plugin settings and restart Homebridge.
3. Check Homebridge logs for onboarding code.
4. Message your bot: `/start <onboarding-code>`.
5. Bot links your chat and enables commands.

## Telegram commands

- `/help`
- `/health`
- `/watchdog`
- `/ask <question>`
- `/automation list`
- `/automation add <name> | <cron> | <prompt>`
- `/automation remove <id>`
- `/automation toggle <id> <on|off>`

## Safety model

- LLM cannot execute arbitrary shell commands.
- LLM can only recommend command IDs from your `selfHealing.commands` allowlist.
- Cooldown and daily action quotas are enforced.

## Local development

```bash
npm install
npm run lint
npm run build
```

## Publish to npm/Homebridge store

```bash
npm login
npm publish --access public
```

After npm publish, the plugin appears in Homebridge search (usually shortly after indexing).

## License

MIT
