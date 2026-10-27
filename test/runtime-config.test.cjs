const assert = require('node:assert/strict');
const test = require('node:test');

const {
  deepMerge,
  getAtPath,
  parseUserValue,
  redactSecrets,
  setAtPath,
  unsetAtPath,
} = require('../dist/runtime/runtime-config');

test('deepMerge preserves nested defaults and replaces arrays', () => {
  assert.deepEqual(
    deepMerge(
      { provider: { model: 'default', timeout: 30 }, commands: ['one'] },
      { provider: { timeout: 60 }, commands: ['two'] },
    ),
    { provider: { model: 'default', timeout: 60 }, commands: ['two'] },
  );
});

test('path helpers update and remove nested values', () => {
  const value = {};
  setAtPath(value, ['monitoring', 'enabled'], true);
  assert.equal(getAtPath(value, ['monitoring', 'enabled']), true);
  unsetAtPath(value, ['monitoring', 'enabled']);
  assert.equal(getAtPath(value, ['monitoring', 'enabled']), undefined);
});

test('configuration paths reject prototype keys before changing any values', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const value = {};
    assert.throws(() => setAtPath(value, ['nested', key, 'polluted'], true), /Unsafe configuration path/);
    assert.deepEqual(value, {});
    assert.throws(() => unsetAtPath(value, [key, 'toString']), /Unsafe configuration path/);
    assert.equal(getAtPath(value, [key]), undefined);
  }
});

test('deepMerge rejects prototype keys even inside newly added objects', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const override = JSON.parse(`{"nested":{"${key}":{"polluted":true}}}`);
    assert.throws(() => deepMerge({}, override), /Unsafe configuration path/);
  }
  assert.equal(Object.prototype.polluted, undefined);
});

test('path helpers do not read or mutate inherited objects', () => {
  const inherited = { enabled: true };
  const value = Object.create({ monitoring: inherited });
  assert.equal(getAtPath(value, ['monitoring']), undefined);
  unsetAtPath(value, ['monitoring', 'enabled']);
  assert.equal(inherited.enabled, true);
  setAtPath(value, ['monitoring', 'enabled'], false);
  assert.equal(inherited.enabled, true);
  assert.deepEqual(value.monitoring, { enabled: false });
});

test('parseUserValue handles booleans, numbers, JSON, and strings', () => {
  assert.equal(parseUserValue(' true '), true);
  assert.equal(parseUserValue('42.5'), 42.5);
  assert.deepEqual(parseUserValue('{"enabled":true}'), { enabled: true });
  assert.equal(parseUserValue('"plain text"'), 'plain text');
});

test('redactSecrets masks a cloned value without mutating the source', () => {
  const original = {
    provider: { apiKey: 'secret-key', model: 'example' },
    messaging: { botToken: 'bot-secret' },
  };
  const redacted = redactSecrets(original, [
    ['provider', 'apiKey'],
    ['messaging', 'botToken'],
  ]);

  assert.equal(redacted.provider.apiKey, '***');
  assert.equal(redacted.messaging.botToken, '***');
  assert.equal(original.provider.apiKey, 'secret-key');
});
