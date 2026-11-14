// 使用已安装 DSH 的 Electron Node 运行本文件，不安装依赖，不调用任何真实模型。
// 真实 Cordis/工具 schema 与注册生命周期；用户选择和 agent 投递由测试替身提供。
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

async function main() {
  const runtime = process.argv[2];
  if (!runtime) throw new Error('用法：Electron --expose-internals dsh-host-smoke.cjs <app.asar/dsh>');
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/')) return next(specifier, { ...context, parentURL: pathToFileURL(path.join(runtime, 'package.json')).href });
    return next(specifier, context);
  } });
  const { Context } = await import('@deepseek-ai/cordis');
  const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');
  const { default: Tools } = await import('@deepseek-ai/dsh-tools');
  const { assertV4RowAdmission } = await import('@deepseek-ai/dsh-session-format-v3-to-v4');
  const { loadProfile, createRuntimeResolution, PluginPackages, evaluatePluginCompatibility, getDshRuntimeVersion } = await import('@deepseek-ai/dsh-app-boot');

  const { SubagentRuntime } = await import('@deepseek-ai/dsh-subagent');
  const { createScope } = await import('@deepseek-ai/dsh-scope');
  const hostVersion = getDshRuntimeVersion();
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
  // 先通过真实宿主的加载门槛；仅直接 import 成功不足以证明插件可启用。
  assert.equal(evaluatePluginCompatibility(manifest, {}, hostVersion), undefined, '宿主会拒绝当前依赖范围');
  const legacyManifest = { ...manifest, peerDependencies: { '@deepseek-ai/dsh-tools': '0.2.0-rc.2' } };
  if (hostVersion !== '0.2.0-rc.2') assert.ok(evaluatePluginCompatibility(legacyManifest, {}, hostVersion));
  const nativeStart = typeof SubagentRuntime.prototype.startActivation === 'function' ? 'startActivation' : 'startContinuable';
  const flatActivation = typeof SubagentRuntime.prototype.rootOf === 'function';
  for (const method of [nativeStart, 'sendMessage', 'interrupt', 'resolveMaxDepth']) assert.equal(typeof SubagentRuntime.prototype[method], 'function', '宿主缺少接口 ' + method);
  hooks.deregister();
  const anchor = path.join(runtime, 'package.json');
  const profile = loadProfile('dsh', 'desktop', anchor);
  const ctx = new Context();
  // 采用真实解析器，避免测试钩子掩盖本地链接包未声明 peerDependencies 的问题。
  await ctx.plugin(PluginPackages, { resolution: await createRuntimeResolution({ installAnchor: anchor, profile }) });
  const plugin = await import(pathToFileURL(path.resolve(__dirname, '../index.mjs')));
  const root = path.resolve(__dirname, '../.runtime/host-smoke-' + Date.now());
  const notifications = [];
  const parent = { id: 'smoke-parent', session: { header: { cwd: root }, requestHeader: () => ({ config: { provider: 'deepseek', model: 'fixture' } }) }, options: {}, followup(message) {
    // 真实 v4 admission 拒绝旧来源标签，测试不能只检查消息是否被调用。
    assertV4RowAdmission({ type: 'user/message', data: message });
    assert.equal(message.role, 'user'); assert.ok(message.id);
    notifications.push(message);
  } };
  const answers = [];
  let approved = false;
  ctx.provide('agents', { get: id => id === parent.id ? parent : undefined });
  let starts = 0, followups = 0, fixtureChildId = 'fixture-child', policyChecks = 0;
  const checkChildPolicy = async id => {
    const agent = { id }; const childScope = createScope(ctx, agent); agent.ctx = childScope.ctx;
    try {
      await ctx.serial('agent/created', { agent });
      // 使用真实 Tools 守卫验证子作用域，不把提示词当作权限约束。
      assert.equal(ctx.tools.checkGuards({ agent, name: 'read' }), undefined);
      assert.match(ctx.tools.checkGuards({ agent, name: 'write' }).reason, /权限/);
      assert.match(ctx.tools.checkGuards({ agent, name: 'spawn_agent' }).reason, /权限/);
      assert.equal(ctx.tools.checkGuards({ agent: parent, name: 'write' }), undefined);
      policyChecks++;
    } finally { await childScope.dispose(); }
  };
  ctx.provide('subagents', { resolveMaxDepth: () => 1, interrupt: () => {},
    ...(flatActivation ? { rootOf: () => parent } : {}),
    [nativeStart]: async spec => {
      starts++;
      if (flatActivation) {
        // 经真实 startActivation 检查平铺参数；只替换最终调度器，不运行模型。
        return SubagentRuntime.prototype.startActivation.call({
          expectProvider: () => ({ prepareContinuable() {} }), assertCapabilities() {}, ctx,
          requireManager: () => ({ async startLocal(actual) {
            assert.equal(actual.parent, parent); assert.equal(actual.delivery, 'parent');
            assert.equal(actual.agentOptions.provider, 'deepseek'); assert.equal(actual.request, undefined);
            fixtureChildId = actual.childId; assert.ok(fixtureChildId);
            await checkChildPolicy(fixtureChildId);
            return { childId: fixtureChildId, result: Promise.resolve({ output: [], stopReason: 'completed' }) };
          } }),
        }, spec);
      }
      assert.equal(spec.request.parent, parent); assert.deepEqual(spec.request.toolFilter.allow, ['read', 'read_image', 'glob', 'grep']);
      if (nativeStart === 'startActivation') assert.equal(spec.delivery, 'parent');
      return { childId: 'fixture-child', result: Promise.resolve({ output: [], stopReason: 'completed' }) };
    }, sendMessage: async (_parent, id) => {
      assert.equal(id, fixtureChildId);
      if (flatActivation) await checkChildPolicy(id); // 模拟冷恢复，检查已保存角色重新施加权限。
      followups++;
    } });
  ctx.provide('userQuestions', { ask: async request => { answers.push(request); return { answers: request.questions.map(q => ({ id: q.id, selected: [approved ? '确认' : '取消'] })) }; } });
  try {
    // 0.2.1 将 slots/primitives 合并进浏览器公共包，不再提供 Node 包入口。
    // 这里只检查实际发布的客户端依赖；插槽挂载和渲染由本机 UI 验证。
    const frontend = path.join(runtime, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets');
    const frontendCode = fs.readdirSync(frontend).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(frontend, f), 'utf8')).join('\n');
    for (const name of ['@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives']) assert.ok(frontendCode.includes(name), '客户端公共包缺失：' + name);
    await ctx.plugin(SystemPrompt); await ctx.plugin(Tools);
    const fiber = await ctx.plugin(plugin, { stateDir: root });
    // Cordis 的插件可能异步初始化；等待状态就绪后检查真实注册表。
    for (let n = 0; n < 100 && !ctx.tools?.get('dots_start'); n++) await new Promise(r => setTimeout(r, 20));
    const schemas = ctx.tools.schemas();
    assert.equal(schemas.filter(t => t.name.startsWith('dots_')).length, 15);
    const startSchema = schemas.find(t => t.name === 'dots_start');
    assert.match(JSON.stringify(startSchema), /"workers":\{"type":"array"/);
    // 经真实 Cordis waterfall 验证挂钩，模型响应用缺括号的固定数据，不调用真实模型。
    const failure = { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: tool input is invalid JSON' };
    const attempt = { type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [
      { type: 'chunk', chunk: { type: 'block-end', block: { type: 'tool-call', name: 'dots_start', arguments: '{"proposal":{"workers":[{},"quota":{}}}' } } },
      { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure } } },
    ] } };
    const failedEvents = [attempt];
    parent.session.snapshotEvents = () => failedEvents;
    const recoveryPayload = { agent: parent, turn: 1, step: 1, failure, signal: new AbortController().signal };
    assert.deepEqual(await ctx.waterfall('agent/request-error', recoveryPayload, async () => undefined), { kind: 'retry' });
    failedEvents.push(attempt);
    assert.equal(await ctx.waterfall('agent/request-error', recoveryPayload, async () => { throw Error('重试超限'); }), undefined);
    const execution = { agent: parent, signal: new AbortController().signal, callId: 'smoke-call' };
    const tool = ctx.tools.get('dots_start');
    await assert.rejects(tool.execute({ proposal: { goal: '离线冒烟测试', plan: '取消后不执行', workers: [{ name: 'read', backend: 'deepseek', role: '读取', cwd: root, instruction: '无需执行' }] } }, execution), /用户未确认/);
    assert.equal(answers.length, 1);
    assert.equal(fs.readdirSync(root).filter(x => /^run-/.test(x)).length, 0);
    approved = true;
    const started = await tool.execute({ proposal: { goal: '通知测试', plan: '使用测试替身，立即暂停', workers: [{ name: 'read', backend: 'deepseek', role: '读取', cwd: root, instruction: '无需执行' }] } }, execution);
    const run = await ctx.tools.get('dots_status').execute({ runId: started.id }, execution);
    assert.equal(answers.at(-1).questions[0].intent.callId, undefined);
    const waitFor = async predicate => { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('子对话状态未到达：' + run.reason + JSON.stringify(run.workers)); };
    await waitFor(() => run.workers[0].childId);
    assert.equal(starts, 1);
    // 模型输出替身经真实 Cordis 生命周期事件进入引擎；不消耗模型额度。
    ctx.emit('subagent/end', { id: fixtureChildId, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '第一轮结果' }] });
    await waitFor(() => run.workers[0].status === 'awaiting-decision');
    assert.match(run.workers[0].reply, /第一轮结果/);
    await ctx.tools.get('dots_control').execute({ runId: run.id, action: 'pause' }, execution);
    await ctx.tools.get('dots_control').execute({ runId: run.id, action: 'resume' }, execution);
    await ctx.tools.get('dots_dispatch').execute({ runId: run.id, worker: 'read', instruction: '第二轮协议替身', decisionId: run.workers[0].decision.id }, execution);
    await waitFor(() => followups === 1);
    assert.equal(starts, 1, '恢复后应续接原子对话');
    ctx.emit('subagent/end', { id: fixtureChildId, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '第二轮结果' }] });
    await waitFor(() => run.workers[0].status === 'awaiting-decision');
    assert.match(run.workers[0].reply, /第二轮结果/);
    assert.ok(notifications.length > 0);
    if (flatActivation) assert.equal(policyChecks, 2);
    console.log(JSON.stringify({ ok: true, runtime, hostVersion, nativeStart, tools: schemas.filter(t => t.name.startsWith('dots_')).map(t => t.name), checks: ['真实宿主兼容门槛与原生子对话接口', '完成事件、暂停恢复及原子对话续发', '真实 DSH 结构化 schema 注册', '真实 Cordis 解析错误恢复挂钩与次数限制', '用户取消后零任务', '计划采用临时资源', '通知通过 v4 admission', '插件卸载清理'] }));
    await fiber.dispose();
    assert.equal(ctx.tools.get('dots_start'), undefined);
    assert.equal(fs.existsSync(path.join(root, 'host.lock')), false);
  } catch (error) { console.error('HOST CHECK FAILED', error); throw error;
  } finally {
    await ctx.fiber.dispose();
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });



