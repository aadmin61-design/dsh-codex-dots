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
  const { loadProfile, createRuntimeResolution, PluginPackages } = await import('@deepseek-ai/dsh-app-boot');

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
  ctx.provide('subagents', { resolveMaxDepth: () => 1, interrupt: () => {}, startContinuable: async () => ({ childId: 'fixture-child' }) });
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
    assert.equal(schemas.filter(t => t.name.startsWith('dots_')).length, 9);
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
    const run = await tool.execute({ proposal: { goal: '通知测试', plan: '使用测试替身，立即暂停', workers: [{ name: 'read', backend: 'deepseek', role: '读取', cwd: root, instruction: '无需执行' }] } }, execution);
    assert.equal(answers.at(-1).questions[0].intent.callId, undefined);
    await ctx.tools.get('dots_control').execute({ runId: run.id, action: 'pause' }, execution);
    assert.ok(notifications.length > 0);
    console.log(JSON.stringify({ ok: true, runtime, tools: schemas.filter(t => t.name.startsWith('dots_')).map(t => t.name), checks: ['真实 DSH 结构化 schema 注册', '真实 Cordis 解析错误恢复挂钩与次数限制', '用户取消后零任务', '计划采用临时资源', '通知通过 v4 admission', '插件卸载清理'] }));
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
