# homebridge-llm-control

LLM-powered operations plugin for Homebridge with:

- LLM provider presets (`OpenAI` + custom OpenAI-compatible endpoint)
- Telegram onboarding + chat control
- Direct control of existing Homebridge accessories (lights/switches/outlets) from Telegram
- One-shot scheduling ("turn off the lights in 30 minutes")
- Optional scheduled Homebridge restarts + restart notifications
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

You can configure this plugin either:

- In Homebridge UI plugin settings / `config.json`, or
- Directly from Telegram (recommended for “dirt simple” setup): `/setup` and `/config ...`

### Example config

Minimal (Telegram only; then configure the LLM via `/setup` in chat):

```json
{
  "platform": "LLMControl",
  "name": "LLM Control",
  "messaging": {
    "botToken": "123456789:AA...",
    "pairingMode": "first_message"
  }
}
```

Full example:

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
    "pairingMode": "first_message",
    "pollIntervalMs": 2000
  },
  "homebridgeControl": {
    "enabled": true,
    "includeChildBridges": true,
    "refreshIntervalSeconds": 60
  },
  "operations": {
    "scheduledRestartEnabled": false,
    "restartEveryHours": 12,
    "notifyOnHomebridgeStartup": false,
    "notifyOnHomebridgeRestart": true
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
2. Paste the token in plugin settings.
3. Choose a pairing mode:
   - **Auto-link first chat (easiest):** send any message to your bot and it will link that chat.
   - **Secret:** set a pairing secret in plugin settings, then send `/link <secret>` to your bot.
   - **Onboarding code:** the plugin will accept `/start <code>` (code is shown in Homebridge logs).
4. Run `/setup` in Telegram to configure your LLM provider (API key + model) from chat.

## Telegram commands

- `/status`
- `/unlink`
- `/help`
- `/setup`
- `/cancel`
- `/hb` (device control help)
- `/hb list [query]`
- `/hb on <query|id|lights|switches|outlets|all>`
- `/hb off <query|id|lights|switches|outlets|all>`
- `/hb schedule <duration> <on|off> <query|id|lights|switches|outlets|all>`
- `/jobs list`
- `/jobs cancel <jobId>`
- `/health`
- `/watchdog`
- `/ask <question>`
- `/config` (show/set/get/reset runtime settings)
- `/commands` (list self-healing command IDs)
- `/run <commandId>` (run an allowed self-healing command)
- `/automation list`
- `/automation add <name> | <cron> | <prompt>`
- `/automation remove <id>`
- `/automation toggle <id> <on|off>`

## Controlling lights and devices

This plugin controls your existing Homebridge accessories directly via Homebridge's local HAP HTTP endpoints (in insecure mode).

Quick start:

1. Configure Telegram and link the chat.
2. In Telegram, run: `/hb list`
3. Turn something off: `/hb off <query>` (example: `/hb off floor lamp`)
4. Schedule an action: `/hb schedule 30m off lights`

Tip: once your LLM provider is configured, you can also just type: "turn off the lights in 30 minutes".

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
