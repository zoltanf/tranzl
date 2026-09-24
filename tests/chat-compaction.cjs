const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareContext, budgets } = require('../src/chatCompaction');
const count = async items => 100 + Math.ceil(items.reduce((n, m) => n + m.content.length + (m.media?.length || 0) * 4000, 0) / 4);
function setup(extra = {}) {
  const calls = [];
  return { calls, options: { contextSize: 8192, effort: 'balanced', count, signal: new AbortController().signal,
    summarize: async (messages, system, limit) => { calls.push({ messages, system, limit }); assert.ok(await count(messages) <= budgets(8192).trigger); return 'Key fact: the launch date is Friday. Preserve that constraint.'; }, ...extra } };
}
test('small context is unchanged and response space is reserved', async () => {
  const { options, calls } = setup(); const messages = [{ role: 'user', content: 'Hello' }];
  const result = await prepareContext({ ...options, messages });
  assert.equal(result.messages, messages); assert.equal(result.maxTokens, 2048); assert.equal(calls.length, 0);
});
test('compacts long history without modifying the saved transcript', async () => {
  const { options } = setup(); const messages = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'old details '.repeat(700) }));
  messages.push({ role: 'user', content: 'What is the launch date?' }); const original = structuredClone(messages);
  const result = await prepareContext({ ...options, messages });
  assert.ok(result.compaction.beforeTokens > 8192); assert.ok(result.compaction.afterTokens <= budgets(8192).target);
  assert.equal(result.messages.at(-1).content, messages.at(-1).content); assert.deepEqual(messages, original);
});
test('oversized single PDF is read in bounded chunks, preserving current question', async () => {
  const { options, calls } = setup();
  const messages = [{ role: 'user', content: 'When is the launch?\n\n<attached-file name="report.pdf">\n' + 'The launch date is Friday. '.repeat(2500) + '\n</attached-file>' }];
  const result = await prepareContext({ ...options, messages });
  assert.ok(calls.length > 1); assert.match(result.messages.at(-1).content, /^When is the launch/);
  assert.match(result.messages.at(-1).content, /Friday/); assert.ok(result.compaction.afterTokens < 8192);
});
test('large media is rejected before trying an oversized summarization', async () => {
  const { options, calls } = setup({ count: async items => items.some(m => m.media?.length) ? 13000 : count(items) });
  await assert.rejects(prepareContext({ ...options, messages: [{ role: 'user', content: 'Read this', media: [{ kind: 'image', data: 'abc' }] }] }), /single image\/audio/);
  assert.equal(calls.length, 0);
});
test('abort during chunking stops before another summary', async () => {
  const controller = new AbortController(); let calls = 0;
  const { options } = setup({ signal: controller.signal, summarize: async () => { calls++; controller.abort(); return 'notes'; } });
  await assert.rejects(prepareContext({ ...options, messages: [{ role: 'user', content: '<attached-file name="a">\n' + 'words '.repeat(10000) + '\n</attached-file>' }] }), { name: 'AbortError' });
  assert.equal(calls, 1);
});
test('empty summary fails without discarding source; thorough reserves more output', async () => {
  const { options } = setup({ summarize: async () => '' });
  await assert.rejects(prepareContext({ ...options, messages: [{ role: 'user', content: '<attached-file name="a">\n' + 'words '.repeat(10000) + '\n</attached-file>' }] }), /empty context summary/);
  assert.ok(budgets(8192, 'thorough').trigger < budgets(8192, 'balanced').trigger);
});
test('compaction reports incremental, non-decreasing progress', async () => {
  const statuses = [];
  const { options } = setup({ onStatus: (text, progress) => statuses.push([text, progress]) });
  const messages = [{ role: 'user', content: 'Summarize this.\n\n<attached-file name="a">\n' + 'words '.repeat(10000) + '\n</attached-file>' }];
  const result = await prepareContext({ ...options, messages });
  assert.ok(statuses.length > 2);
  assert.deepEqual(statuses[0], ['Compacting context… Original messages remain saved.', 0]);
  const fractions = statuses.map(([, progress]) => progress);
  assert.ok(fractions.every(f => Number.isFinite(f) && f >= 0 && f <= .99));
  assert.deepEqual(fractions, [...fractions].sort((a, b) => a - b));
  assert.ok(fractions.at(-1) > 0);
  assert.match(statuses.at(-1)[0], /reading part/);
});
