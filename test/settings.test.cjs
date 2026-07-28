const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeConfig } = require('../dist/settings');

test('normalizes strings and enables configured messaging channels', () => {
  const config = normalizeConfig({
    name: 'LLM Control',
    provider: { model: '  example-model  ' },
    messaging: { botToken: '  bot-token  ' },
    ntfy: { topic: '  home-topic  ' },
    discordWebhook: { webhookUrl: '  https://example.com/webhook  ' },
  });

  assert.equal(config.provider.model, 'example-model');
  assert.equal(config.messaging.enabled, true);
  assert.equal(config.messaging.botToken, 'bot-token');
  assert.equal(config.ntfy.enabled, true);
  assert.equal(config.ntfy.topic, 'home-topic');
  assert.equal(config.discordWebhook.enabled, true);
});

test('drops blank UI rows while retaining valid commands and automations', () => {
  const config = normalizeConfig({
    selfHealing: {
      commands: [
        {},
        { id: 'restart', label: 'Restart Homebridge', command: 'hb-service restart' },
      ],
    },
    automations: [
      {},
      { name: 'Morning check', scheduleCron: '0 8 * * *', prompt: 'Check health.' },
    ],
  });

  assert.deepEqual(config.selfHealing.commands.map((command) => command.id), ['restart']);
  assert.deepEqual(config.automations.map((automation) => automation.name), ['Morning check']);
});

test('rejects invalid schedules before runtime initialization', () => {
  assert.throws(
    () => normalizeConfig({ monitoring: { dailyMonitoringTime: '25:90' } }),
    /Invalid configuration/,
  );
});
