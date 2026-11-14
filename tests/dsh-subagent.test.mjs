import test from 'node:test';
import assert from 'node:assert/strict';
import { startNativeChild, applyChildPolicy } from '../lib/dsh-subagent.mjs';

test('0.2.2 平铺参数保留父级身份、预留 ID 和模型，不发送废弃字段', async () => {
  const spec = { childId: 'reserved', provider: 'spawn', signal: new AbortController().signal,
    request: { parent: { id: 'parent' }, prompt: [{ type: 'text', text: '任务' }], agentOptions: { provider: 'deepseek' }, maxDepth: 1, persona: '职责', toolFilter: { allow: ['read'] } } };
  await startNativeChild({ rootOf() {}, async startActivation(arg) {
    assert.equal(arg.parent, spec.request.parent); assert.equal(arg.prompt, spec.request.prompt);
    assert.equal(arg.agentOptions, spec.request.agentOptions); assert.equal(arg.childId, spec.childId);
    assert.equal(arg.signal, spec.signal); assert.equal(arg.maxDepth, 1); assert.equal(arg.delivery, 'parent');
    for (const name of ['request', 'persona', 'toolFilter']) assert.equal(name in arg, false);
    return { childId: arg.childId };
  } }, spec, () => {});
});

test('新版子作用域权限守卫拒绝写入和继续委派，保留允许工具', () => {
  let guard, section;
  const services = { tools: { guard: fn => { guard = fn; } }, systemPrompt: { section: value => { section = value; } } };
  applyChildPolicy({ ctx: { get: name => services[name] } },
    { toolFilter: { allow: ['read', 'grep'] }, persona: '只读角色' });
  assert.equal(guard({ name: 'read' }), undefined);
  for (const name of ['write', 'bash', 'spawn_agent', 'dots_start']) assert.match(guard({ name }), /权限/);
  assert.match(section.text, /只读角色/); assert.match(section.text, /read、grep/);
});

// 结果 promise 永不完成也应立即返回，保证主对话不会长期等待子模型。
test('新版 activation 保留父级通知、权限请求并后台执行', async () => {
  const spec = { provider: 'spawn', request: { toolFilter: { allow: ['read'] }, maxDepth: 1 }, signal: new AbortController().signal };
  const child = await startNativeChild({ async startActivation(arg) {
    assert.equal(arg.delivery, 'parent'); assert.equal(arg.request, spec.request); assert.equal(arg.signal, spec.signal);
    return { childId: 'child', result: new Promise(() => {}) };
  }, startContinuable() { assert.fail('新版不应调用旧接口'); } }, spec, () => assert.fail('意外错误'));
  assert.equal(child.childId, 'child');
});

test('旧版 continuable 保持原参数和调用上下文', async () => {
  const spec = { request: {} };
  const service = { async startContinuable(arg) { assert.equal(this, service); assert.equal(arg, spec); return { childId: 'legacy' }; } };
  assert.equal((await startNativeChild(service, spec, () => {})).childId, 'legacy');
});

test('新版创建失败不降级重试，缺失接口明确报错', async () => {
  let retries = 0;
  await assert.rejects(startNativeChild({ startActivation() { throw Error('拒绝创建'); }, startContinuable() { retries++; } }, {}, () => {}), /拒绝创建/);
  assert.equal(retries, 0);
  await assert.rejects(startNativeChild({}, {}, () => {}), /没有可用/);
});

test('结果捕获异常上报一次，不产生未处理拒绝', async () => {
  const errors = [];
  await startNativeChild({ async startActivation() { return { childId: 'child', result: Promise.reject(Error('捕获失败')) }; } }, {}, e => errors.push(e.message));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ['捕获失败']);
});
