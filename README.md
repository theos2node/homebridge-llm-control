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
- `/devices`
- `/device add <switch|light> <name>`
- `/device remove <id>`
- `/device rename <id> <new name>`
- `/set <id> <on|off>`
- `/set <id> brightness <0-100>`

## Controlling lights and devices

Homebridge runs many plugins in separate child bridge processes. A plugin can’t reliably “reach into” other child bridges to directly toggle their accessories.

This plugin provides **virtual HomeKit devices** you can control from Telegram. Then you mirror them to real accessories using HomeKit automations:

1. Create a virtual device from chat, for example: `/device add light Kitchen Light`
2. In the Home app, create an automation:
   - “When Kitchen Light is controlled…”
   - Set your real light accessory to match
3. Now you can message your bot things like “turn on kitchen light” (LLM configured) or use `/set <id> on`

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
