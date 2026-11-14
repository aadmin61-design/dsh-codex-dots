import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { installPanelApi } from '../lib/panel-api.mjs';

test('目录握手报告删除能力，删除路由已注册且拒绝未确认请求时返回 JSON', async () => {
  const routes=new Map();
  const ctx={connection:{fetch:{register:r=>{routes.set(r.path,r);return()=>routes.delete(r.path);}}}};
  const service={projects:async()=>({projects:[],errors:[]})};
  const panel=installPanelApi(ctx,{runs:new Map()},{conversations:()=>service});
  try{
    const prefix='http://dsh.internal/api/codex-dots/';
    const response=await routes.get('/api/codex-dots/conversation-projects').fetch(new Request(prefix+'conversation-projects'));
    const data=await response.json();assert.equal(data.pluginVersion,'2.6.10');assert.ok(data.capabilities.includes('permanent-delete-v1'));
    assert.ok(routes.has('/api/codex-dots/conversation-delete-plan'));
    const denied=await routes.get('/api/codex-dots/conversation-delete-confirm').fetch(new Request(prefix+'conversation-delete-confirm',{method:'POST',body:JSON.stringify({token:'invalid',step:2})}));
    assert.equal(denied.status,400);assert.match((await denied.json()).error,/确认已失效/);
  }finally{await panel.close();}
});

// 只验证面板与宿主协议，不启动模型或打开无认证端口。
test('面板只读、主对话过滤、接管占用及继续目标校验', async () => {
  const routes = new Map(), messages = []; let opens = 0, closes = 0;
  const parent = { id: 'parent', session: { header: {} } };
  const ctx = { agents: { get: id => id === 'parent' ? parent : undefined }, connection: { fetch: {
    register: route => { routes.set(route.path, route); return () => routes.delete(route.path); },
  } } };
  const client = { open: async () => { opens++; }, close: async () => { closes++; },
    listThreads: async input => ({ data: [{ id: 'thread-a', cwd: 'C:/test', title: '测试' }], input }),
    readThread: async id => ({ id, cwd: 'C:/test', turns: [] }),
  };
  const runs = new Map([['r1', { id: 'r1', createdAt: 200, owner: 'parent', status: 'paused', workers: [{ backend: 'codex', threadId: 'thread-a', reply: '结果', streamingReply: '增量' }] }],
    ['old', { id: 'old', createdAt: 100, owner: 'parent', status: 'completed', workers: [{ backend: 'codex', threadId: 'thread-a' }] }],
    ['r2', { id: 'r2', owner: 'other', status: 'paused', workers: [{ backend: 'codex', threadId: 'thread-b' }] }]]);
  const panel = installPanelApi(ctx, { runs }, { clientFactory: () => client, continueInParent: async (...args) => messages.push(args) });
  const request = async (name, params = {}, body) => {
    const url = 'http://dsh.internal/api/codex-dots/' + name + '?' + new URLSearchParams(params);
    const response = await routes.get('/api/codex-dots/' + name).fetch(new Request(url, body ? { method: 'POST', body: JSON.stringify(body) } : {}));
    return { status: response.status, body: await response.json() };
  };
  try {
    await Promise.all([request('threads'), request('thread', { threadId: 'thread-a' })]); assert.equal(opens, 1);
    assert.equal(messages.length, 0);
    panel.present('parent', { kind: 'thread', threadId: 'thread-a' });
    const state = (await request('state', { owner: 'parent' })).body;
    // 文件加载顺序不能覆盖最新一次代管的阈值与状态。
    assert.deepEqual(state.runs.map(r => r.id), ['old', 'r1']); assert.equal(state.runs[1].workers[0].streamingReply, '增量');
    assert.equal(state.hint.threadId, 'thread-a'); assert.equal((await request('state')).body.runs.length, 0);
    assert.equal((await request('continue', {}, { owner: 'unknown', threadId: 'thread-a', goal: '继续' })).status, 400);
    assert.equal((await request('continue', {}, { owner: 'parent', threadId: 'thread-a', goal: '' })).status, 400);
    assert.equal((await request('continue', {}, { owner: 'parent', threadId: 'thread-b', goal: '继续' })).status, 400);
    const accepted = await request('continue', {}, { owner: 'parent', threadId: 'thread-a', goal: '  继续核对  ' });
    assert.equal(accepted.status, 200); assert.equal(messages.length, 1);
    assert.equal(messages[0][1].goal, '继续核对'); assert.equal(messages[0][1].run.id, 'r1');
  } finally { await panel.close(); }
  assert.equal(routes.size, 0); assert.equal(closes, 1);
});

test('客户端模块声明和原生插槽注册一致，卸载清理面板资源', () => {
  let plugin; const registered = [], disposed = [], timers = [], effects = [];
  const document = { createElement: () => ({ dataset: {}, remove: () => disposed.push('style') }), head: { append() {} } };
  const sandbox = { window: { __ModuleLoader__: { load: definition => { assert.equal(definition.id, '@local/dsh-codex-dots'); plugin = definition.factory(() => ({})); } } }, document, AbortController,
    setTimeout: fn => { timers.push(fn); return 1; }, clearTimeout: () => disposed.push('timer'), console };
  vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox);
  const ctx = { effect: fn => { const cleanup = fn(); effects.push(cleanup); return cleanup; },
    slots: { inject: (_slot, fn) => fn(), register: (options, Component) => { registered.push({ options, Component }); return () => disposed.push(options.name); } },
    sidebarRightTabs: { register: def => { registered.push({ def }); return () => disposed.push(def.kind); } },
    uiSession: { adapter: { current: { getSnapshot: () => ({}) } } },
  };
  plugin.apply(ctx);
  assert.equal(registered.filter(r => r.def).length, 0);
  assert.equal(registered.some(r => r.options?.name === 'conversation.session.header.utilities'), false);
  assert.ok(registered.some(r => r.options?.name === 'sidebar.panellist'));
  assert.ok(registered.some(r => r.options?.label === '项目对话树'));
  assert.equal(registered.filter(r => r.options?.name === 'sidebar.panellist').length, 1);
  assert.ok(registered.some(r => r.options?.key === 'codex-dots-tree'));
  for (const dispose of effects.reverse()) dispose?.();
  assert.ok(disposed.includes('style'));
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(manifest.exports['./client'], './client.js'); assert.equal(manifest.dsh.client.platform, 'web');
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace'));
});

test('迁移成功但摘要失败时返回已创建对话，避免用户误判而重复迁移', async () => {
  const routes = new Map(); let creates = 0;
  const ctx = { connection: { fetch: { register: r => { routes.set(r.path, r); return () => routes.delete(r.path); } } } };
  const conversations = { create: async () => { creates++; return { sessionId: 'created', key: 'dsh:created', tree: { nodes: [] } }; }, summarize: async () => { throw Error('额度不足'); } };
  const panel = installPanelApi(ctx, { runs: new Map() }, { conversations: () => conversations });
  try {
    const response = await routes.get('/api/codex-dots/conversation-create').fetch(new Request('http://dsh.internal/api/codex-dots/conversation-create', {
      method: 'POST', body: JSON.stringify({ project: 'fixture', parentKey: 'codex:source', summarize: true }),
    }));
    const result = await response.json();
    assert.equal(response.status, 200); assert.equal(result.sessionId, 'created'); assert.equal(result.summaryError, '额度不足'); assert.equal(creates, 1);
  } finally { await panel.close(); }
});
