const assert = require('node:assert/strict');
const test = require('node:test');

const { extractFirstJsonObject } = require('../dist/llm/json');

test('extracts an object from surrounding prose', () => {
  assert.equal(
    extractFirstJsonObject('Result follows:\\n{"status":"ok","findings":[]}\\nDone'),
    '{"status":"ok","findings":[]}',
  );
});

test('keeps braces and escaped quotes inside JSON strings', () => {
  const input = String.raw`prefix {"reply":"Use {care} and say \"done\"","actions":[]} suffix`;
  assert.deepEqual(JSON.parse(extractFirstJsonObject(input)), {
    reply: 'Use {care} and say "done"',
    actions: [],
  });
});

test('returns the first complete object when more text follows', () => {
  assert.equal(extractFirstJsonObject('{"first":true} {"second":true}'), '{"first":true}');
});

test('rejects missing or incomplete JSON objects', () => {
  assert.throws(() => extractFirstJsonObject('no object here'), /complete JSON object/);
  assert.throws(() => extractFirstJsonObject('{"status":"ok"'), /complete JSON object/);
});
