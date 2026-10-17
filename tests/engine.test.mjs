import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Engine, validatePlan } from '../lib/engine.mjs';
import { normalizeQuota, quotaStop, CodexClient } from '../lib/codex.mjs';

// 可控协议替身只用于无计费测试；真实 app-server 的只读检查单独记录。
class FakeCodex extends EventEmitter {
  constructor() { super(); this.calls = []; this.left = 90; this.sequence = 0; this.history = new Map(); this.turns = new Map(); }
  async open() { return this; }
  close() {}
  async models() { return [{ id: 'test-model', model: 'test-model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }]; }
  async quota() { return { windows: [{ bucket: 'codex', minutes: 10080, leftPercent: this.left }] }; }
  async readThread(id) { return structuredClone(this.history.get(id)); }
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: `thread-${++this.sequence}` } };
    if (method === 'turn/start') { const id = `turn-${++this.sequence}`; this.turns.set(params.threadId, id); return { turn: { id } }; }
    if (method === 'turn/steer') this.finish(params.threadId, 'interrupted');
    return {};
  }
  finish(threadId, status = 'completed') {
    const id = this.turns.get(threadId);
    if (this.history.has(threadId)) this.history.get(threadId).turns = [{ id, status }];
    this.emit('notification', { method: 'item/completed', params: { threadId, item: { type: 'agentMessage', text: '已验证结果' } } });
    this.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id, status } } });
  }
}
async function settle(predicate) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('状态未在期限内到达');
}
async function fixture(t) {
  fs.mkdirSync('.runtime', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('.runtime/dots-test-'));
  const client = new FakeCodex(), notes = [], native = [];
  const options = { root, codexFactory: () => client, notify: async (r, n) => { notes.push(n); return true; },
    deepseek: { start: async (r, w) => { native.push(w.name); return 'child-' + w.name; }, stop: async () => {} }, pollMs: 3600000 };
  const engine = new Engine(options); await engine.open();
  t.after(async () => { await engine.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const proposal = { goal: '测试', plan: '只做最小验证', workers: [{ name: 'reader', role: '读取', backend: 'codex', cwd: root, instruction: '读', sandbox: 'read-only' }], quota: { stopAtLeftPercent: 20 }, allowedModels: ['test-model'] };
  const create = p => engine.create('parent', p || proposal, { enable: { at: 1 }, plan: { at: 2 } });
  return { root, engine, client, notes, native, proposal, create, options };
}

test('多 bucket、两窗口、缺失值与百分比边界', () => {
  const q = normalizeQuota({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 69, windowDurationMins: 10080 }, secondary: { usedPercent: 80, windowDurationMins: 300 } },
    other: { primary: { usedPercent: 10, windowDurationMins: 60 } },
  } });
  assert.equal(q.windows.length, 3);
  assert.match(quotaStop(q, { stopAtLeftPercent: 20 }), /20%/);
  assert.equal(quotaStop(q, { stopAtLeftPercent: 20, windowMinutes: 10080 }), null);
  assert.match(quotaStop(q, { stopAtLeftPercent: 20, bucket: 'unknown' }), /无法读取/);
  assert.equal(normalizeQuota({}).windows.length, 0);
});
test('双确认与会话所有权不可绕过，非法路径/权限被拒绝', async t => {
  const f = await fixture(t);
  await assert.rejects(f.engine.create('parent', f.proposal, {}), /用户/);
  const r = await f.create(); assert.throws(() => f.engine.get(r.id, 'stranger'), /不属于/);
  assert.throws(() => validatePlan({ ...f.proposal, workers: [{ ...f.proposal.workers[0], name: '../bad' }] }), /角色名/);
  assert.throws(() => validatePlan({ ...f.proposal, workers: [{ ...f.proposal.workers[0], sandbox: 'danger-full-access' }] }), /只支持/);
});
test('异步期间保留锁；活进程的锁不能靠过期时间夺取', async t => {
  const f = await fixture(t);
  const second = new Engine(f.options);
  await assert.rejects(second.open(), /已有编排器/);
});
test('活跃轮落盘、事件唤醒、同一线程续接、动态调参', async t => {
  const f = await fixture(t), r = await f.create(); await f.engine.start(r);
  await settle(() => r.workers[0].turnId);
  const w = r.workers[0], id = w.threadId;
  f.client.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: id, delta: '实时内容' } });
  assert.equal(w.streamingReply, '实时内容');
  assert.match(fs.readFileSync(path.join(f.root, `run-${r.id}.jsonl`), 'utf8'), /实时内容/);
  f.client.finish(id); await settle(() => f.notes.length === 1);
  assert.equal(w.status, 'awaiting-decision');
  f.engine.tune(r, w.name, { model: 'test-model', effort: 'low' });
  f.engine.dispatch(r, w.name, '检查下一步', w.decision.id); await settle(() => w.turnId);
  assert.equal(w.streamingReply, '');
  assert.equal(w.threadId, id); assert.equal(f.client.calls.filter(c => c.method === 'thread/start').length, 1);
  assert.throws(() => f.engine.dispatch(r, w.name, '重复'), /等待决策/);
  assert.throws(() => f.engine.tune(r, w.name, { sandbox: 'workspace-write' }), /不能自动|空闲/);
  f.client.finish(id); f.engine.complete(r, undefined, '测试产出已验证'); assert.equal(r.status, 'completed');
});
test('额度达到阈值时当前轮 steer 收尾，不创建新轮；低额度禁止恢复', async t => {
  const f = await fixture(t), r = await f.create(); await f.engine.start(r); await settle(() => r.workers[0].turnId);
  f.client.left = 20; await f.engine.tick();
  assert.equal(r.status, 'paused'); assert.equal(r.workers[0].status, 'paused');
  assert.equal(f.client.calls.filter(c => c.method === 'turn/start').length, 1);
  assert.ok(f.client.calls.some(c => c.method === 'turn/steer'));
  await assert.rejects(f.engine.resume(r), /剩余/);
  f.client.left = 80; await f.engine.resume(r); assert.equal(r.workers[0].status, 'awaiting-decision');
});
test('首次额度不足不创建 Codex 会话', async t => {
  const f = await fixture(t), r = await f.create(); f.client.left = 10; await f.engine.start(r);
  await settle(() => r.status === 'paused');
  assert.equal(f.client.calls.filter(c => c.method === 'thread/start').length, 0);
});
test('同目录写入者串行；独立目录可并发；DSH 原生子角色不消耗 Codex 轮次', async t => {
  const f = await fixture(t);
  const p = f.proposal;
  p.workers = [
    { ...p.workers[0], name: 'writer', sandbox: 'workspace-write' },
    { ...p.workers[0], name: 'checker', backend: 'deepseek' },
  ];
  const r = await f.create(p); await f.engine.start(r); await settle(() => r.workers[0].turnId);
  assert.equal(r.workers[1].status, 'queued'); assert.equal(f.native.length, 0);
  f.client.finish(r.workers[0].threadId); await settle(() => r.workers[1].childId);
  assert.equal(f.native.length, 1);
  await f.engine.childEnded(r.workers[1].childId, { stopReason: 'completed', lastAssistantMessage: ['done'] });
  assert.equal(r.workers[1].status, 'awaiting-decision');
});
test('最大轮数、跨任务并发限制、重启后不重放任务', async t => {
  const f = await fixture(t); f.proposal.maxTurns = 1;
  const r = await f.create(); await f.engine.start(r); await settle(() => r.workers[0].turnId);
  f.client.finish(r.workers[0].threadId); f.engine.dispatch(r, 'reader', '第二轮', r.workers[0].decision.id);
  await settle(() => r.status === 'paused'); assert.match(r.reason, /最大轮数/);
  await f.engine.close(); const resumed = new Engine(f.options); await resumed.open();
  assert.equal(resumed.get(r.id, 'parent').status, 'paused'); await resumed.close();
});
test('RPC 启动失败及时拒绝，避免悬挂和泄漏计时器', async () => {
  const c = new CodexClient({ bin: path.join(os.tmpdir(), 'nonexistent-codex-12345.exe'), timeoutMs: 100 });
  try { await assert.rejects(c.open()); assert.equal(c.pending.size, 0); } finally { c.close(); }
});
test('依赖角色需先验收；未知依赖与循环依赖拒绝', async t => {
  const f = await fixture(t), p = f.proposal;
  p.workers.push({ ...p.workers[0], name: 'reviewer', dependsOn: ['reader'] });
  const r = await f.create(); await f.engine.start(r); await settle(() => r.workers[0].turnId);
  assert.equal(r.workers[1].status, 'queued');
  f.client.finish(r.workers[0].threadId);
  assert.equal(r.workers[1].status, 'queued');
  f.engine.complete(r, 'reader', '分析证据通过'); await settle(() => r.workers[1].turnId);
  assert.match(f.client.calls.at(-1).params.input[0].text, /分析证据通过/);
  assert.throws(() => validatePlan({ ...p, workers: [{ ...p.workers[0], dependsOn: ['missing'] }] }), /不存在/);
  assert.throws(() => validatePlan({ ...p, workers: [{ ...p.workers[0], dependsOn: ['reader'] }] }), /环路/);
});
test('收尾无响应后 interrupt，不启动额外总结轮', async t => {
  const f = await fixture(t); f.engine.stopGraceMs = 20;
  const oldCall = f.client.call.bind(f.client);
  f.client.call = async (method, params) => {
    if (method === 'turn/steer') { f.client.calls.push({ method, params }); return {}; }
    if (method === 'turn/interrupt') { f.client.finish(params.threadId, 'interrupted'); }
    return oldCall(method, params);
  };
  const r = await f.create(); await f.engine.start(r); await settle(() => r.workers[0].turnId);
  await f.engine.pause(r, '停止测试'); assert.equal(r.workers[0].status, 'stopping');
  await settle(() => r.workers[0].status === 'paused');
  assert.ok(f.client.calls.some(c => c.method === 'turn/interrupt'));
  assert.equal(f.client.calls.filter(c => c.method === 'turn/start').length, 1);
});
test('离线通知重启后可投递；运行时 flushing/loaded 不持久化', async t => {
  const f = await fixture(t); f.engine.notify = async () => false;
  const r = await f.create(); r.workers[0].loaded = true;
  await f.engine.announce(r, '测试', '待投递');
  assert.equal(r.outbox.length, 1);
  const persisted = JSON.parse(fs.readFileSync(path.join(f.root, `run-${r.id}.json`)));
  assert.equal(persisted.flushing, undefined); assert.equal(persisted.workers[0].loaded, undefined);
  await f.engine.close(); const restored = new Engine(f.options); await restored.open();
  const run = restored.get(r.id, 'parent'); await restored.flush(run);
  assert.equal(run.outbox.length, 0); assert.ok(f.notes.length >= 1); await restored.close();
});

test('恢复漏派发后自动提醒并续跑，旧决策和重复完成事件不会再派发', async t => {
  const f = await fixture(t), r = await f.create(); await f.engine.start(r);
  const w = r.workers[0]; await settle(() => w.turnId); f.client.finish(w.threadId);
  const oldId = w.decision.id;
  await f.engine.pause(r); await f.engine.resume(r);
  assert.throws(() => f.engine.dispatch(r, w.name, '过期事件', oldId), /过期/);
  assert.equal(r.turns, 1);
  // 模拟主 agent 忽略恢复通知，只响应监督器提醒；不用用户第二次提醒。
  f.engine.notify = async (_run, note) => {
    if (note.kind === '决策超时自动提醒') f.engine.dispatch(r, w.name, '自动继续', w.decision.id);
    return true;
  };
  await f.engine.supervise(r, w.decision.nextAt + 1); await settle(() => w.turnId);
  assert.equal(r.turns, 2); assert.equal(r.reminders, 1);
  f.client.finish(w.threadId); const current = w.decision.id;
  f.client.finish(w.threadId); assert.equal(w.decision.id, current);
  f.engine.complete(r, undefined, '两轮完成');
});

test('提醒次数耗尽暂停并上报；额度阈值拦截提醒且不自动恢复', async t => {
  const f = await fixture(t); f.proposal.supervision = { maxDecisionRetries: 1 };
  const r = await f.create(); await f.engine.start(r); const w = r.workers[0]; await settle(() => w.turnId);
  f.client.finish(w.threadId); await settle(() => !r.flushing);
  await f.engine.supervise(r, w.decision.nextAt + 1);
  await f.engine.supervise(r, w.decision.nextAt + 1);
  assert.equal(r.status, 'paused'); assert.equal(r.reminders, 1); assert.equal(r.turns, 1);
  assert.ok(r.alerts.some(a => a.code === 'decision-exhausted'));
  await f.engine.resume(r); f.client.left = 20;
  await f.engine.supervise(r, w.decision.nextAt + 1);
  assert.equal(r.status, 'paused'); assert.equal(r.reminders, 1);
  f.client.left = 80; await f.engine.tick(); assert.equal(r.status, 'paused');
});

test('额度查询期间暂停不会触发旧决策提醒', async t => {
  const f = await fixture(t), r = await f.create(); await f.engine.start(r);
  const w = r.workers[0]; await settle(() => w.turnId); f.client.finish(w.threadId); await settle(() => !r.flushing);
  f.client.quota = async () => { await f.engine.pause(r, '并发暂停'); return { windows: [{ leftPercent: 90 }] }; };
  await f.engine.supervise(r, w.decision.nextAt + 1);
  assert.equal(r.status, 'paused'); assert.equal(r.reminders, 0);
});

test('通知有限重投后暂停；离线事件合并且已过期决策被丢弃', async t => {
  const f = await fixture(t), r = await f.create(); r.status = 'running';
  f.engine.notify = async () => { throw new Error('模拟宿主拒收'); };
  await f.engine.announce(r, '测试', '失败');
  for (let i = 0; i < 2; i++) { r.outbox[0].nextDeliveryAt = 0; await f.engine.flush(r); }
  assert.equal(r.status, 'paused'); assert.ok(r.alerts.some(a => a.code === 'delivery-exhausted'));
  f.engine.notify = async () => false;
  r.outbox = []; await f.engine.resume(r); const w = r.workers[0];
  await f.engine.supervise(r, w.decision.nextAt + 1);
  assert.equal(r.outbox.length, 1); assert.equal(r.reminders, 0);
  await f.engine.pause(r); f.engine.notify = async (_r, n) => { f.notes.push(n); return true; };
  await f.engine.flush(r); assert.ok(!f.notes.some(n => n.decisionId));
});

test('接管已有对话保持 ID、权限与轮数，暂停占用不允许另一任务接管', async t => {
  const f = await fixture(t); const id = 'existing-1';
  f.client.history.set(id, { id, title: '原对话', cwd: f.root, status: { type: 'notLoaded' }, turns: [{ id: 'old', status: 'completed' }] });
  f.proposal.workers[0].existingThreadId = id;
  const r = await f.create(); await f.engine.start(r); const w = r.workers[0]; await settle(() => w.turnId);
  assert.equal(w.threadId, id); assert.equal(f.client.calls.filter(c => c.method === 'thread/start').length, 0);
  const resume = f.client.calls.find(c => c.method === 'thread/resume');
  assert.equal(resume.params.sandbox, 'read-only'); assert.equal(resume.params.approvalPolicy, 'never');
  f.client.finish(id); assert.equal(w.historyHead, f.client.turns.get(id));
  await f.engine.pause(r); await assert.rejects(f.create(), /已被/);
  await f.engine.resume(r); f.engine.dispatch(r, w.name, '继续', w.decision.id); await settle(() => w.turnId);
  assert.equal(r.turns, 2); f.client.finish(id); f.engine.complete(r, undefined, '验收');
  const next = await f.create(); assert.equal(next.workers[0].historyHead, w.historyHead);
});

test('接管拒绝错误目录、活跃轮次和外部历史变化', async t => {
  const f = await fixture(t), id = 'existing-2'; f.proposal.workers[0].existingThreadId = id;
  const snapshot = { id, cwd: f.root, status: { type: 'active' }, turns: [{ id: 'old', status: 'inProgress' }] };
  f.client.history.set(id, snapshot); await assert.rejects(f.create(), /正在运行/);
  snapshot.status.type = 'notLoaded'; await assert.rejects(f.create(), /正在运行/);
  snapshot.turns[0].status = 'completed'; snapshot.cwd = os.tmpdir(); await assert.rejects(f.create(), /目录/);
  snapshot.cwd = f.root; const r = await f.create(); snapshot.turns[0].id = 'external';
  await f.engine.start(r); await settle(() => r.status === 'paused');
  assert.match(r.reason, /外部新轮次/); assert.equal(r.turns, 0);
  assert.equal(f.client.calls.filter(c => c.method === 'turn/start').length, 0);
});

test('写入者占用导致准备失败时零模型轮次；历史读取复用代管连接', async t => {
  const f = await fixture(t), id = 'writer-busy';
  f.client.history.set(id, { id, cwd: f.root, status: { type: 'notLoaded' }, turns: [] });
  f.proposal.workers[0].existingThreadId = id;
  const r = await f.create(), call = f.client.call.bind(f.client);
  f.client.call = async (method, params) => {
    if (method === 'thread/resume') throw new Error('already has an active writer');
    return call(method, params);
  };
  await f.engine.start(r); await settle(() => r.status === 'paused');
  assert.equal(r.turns, 0); assert.equal(r.workers[0].turns, 0);
  assert.equal(f.client.calls.filter(c => c.method === 'turn/start').length, 0);
  f.engine.factory = () => { throw new Error('不应创建旁路客户端'); };
  assert.equal((await f.engine.inspectThread(id, { limit: 1 })).id, id);
});

test('同时接管同一线程只接受一个；配置拒绝无界重试', async t => {
  const f = await fixture(t), id = 'existing-3'; f.proposal.workers[0].existingThreadId = id;
  f.client.history.set(id, { id, cwd: f.root, status: { type: 'idle' }, turns: [] });
  const results = await Promise.allSettled([f.create(), f.create()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.throws(() => validatePlan({ ...f.proposal, supervision: { maxDecisionRetries: Infinity } }), /必须/);
  assert.throws(() => validatePlan({ ...f.proposal, workers: [...f.proposal.workers, { ...f.proposal.workers[0], name: 'second' }] }), /同一个/);
});
