import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestRecovery } from '../lib/request-recovery.mjs';

const failure = { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: tool input is invalid JSON' };
// 复现现场的缺失数组闭合符，不复制用户项目资料或执行任何真实任务。
const bad = '{"proposal":{"workers":[{"name":"read","instruction":"只读"},"quota":{"stopAtLeftPercent":15}}}';
const call = (name = 'dots_start', args = bad) => ({ type: 'chunk', chunk: { type: 'block-end', block: { type: 'tool-call', name, arguments: args } } });
const attempt = (calls = [call()], turn = 1, step = 2) => ({ type: 'assistant/attempt', data: { turn, step, stream: [...calls,
  { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure } } }] } });
const payload = (events, overrides = {}) => ({ agent: { session: { header: {}, snapshotEvents: () => events } }, turn: 1, step: 2,
  failure, signal: new AbortController().signal, ...overrides });

test('缺失 workers 闭合符仅重生成一次；持久 attempt 跨重载保留上限', async () => {
  const logs = [];
  const handler = () => createRequestRecovery({ warn: x => logs.push(x) });
  const next = () => { throw new Error('匹配错误不应委托通用重试'); };
  assert.deepEqual(await handler()(payload([attempt()]), next), { kind: 'retry' });
  assert.equal(await handler()(payload([attempt(), attempt()]), next), undefined);
  assert.equal(logs.length, 2);
  assert.match(logs[1], /上限/);
});

test('混合调用、其他工具、有效 JSON 和执行过的步骤均不自动重放', async () => {
  const handler = createRequestRecovery();
  const next = () => 'delegated';
  for (const events of [
    [attempt([call('dots_dispatch')])], [attempt([call(), call('write')])],
    [attempt([call('dots_start', '{}')])], [attempt([], 1, 2)],
    [attempt(), { type: 'tool/call', data: { turn: 1, step: 2 } }],
    [attempt(), { type: 'assistant/message', data: { turn: 1, step: 2 } }],
    [attempt(), { type: 'step/end', data: { turn: 1, step: 2 } }],
  ]) assert.equal(await handler(payload(events), next), 'delegated');
});

test('其他轮次不耗本轮重生成机会，同轮其他步骤仍共享上限', async () => {
  const handler = createRequestRecovery();
  assert.deepEqual(await handler(payload([attempt(undefined, 0), attempt()]), () => {}), { kind: 'retry' });
  assert.equal(await handler(payload([attempt(undefined, 1, 1), attempt()]), () => {}), undefined);
});

test('取消、卸载、子对话和其他 provider 错误不会被本插件恢复', async () => {
  assert.equal(await createRequestRecovery()(payload([attempt()], { signal: AbortSignal.abort() }), () => 'unexpected'), undefined);
  assert.equal(await createRequestRecovery({ isDisposed: () => true })(payload([attempt()]), () => 'unexpected'), undefined);
  const child = payload([attempt()]); child.agent.session.header.origin = 'subagent';
  assert.equal(await createRequestRecovery()(child, () => 'delegated'), 'delegated');
  assert.equal(await createRequestRecovery()(payload([attempt()], { failure: { code: 'TIMEOUT' } }), () => 'delegated'), 'delegated');
});
