import fs from 'node:fs';
import { updateLiveTurn } from './history.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexClient, quotaStop } from './codex.mjs';

const TERMINAL = new Set(['completed', 'cancelled']);
const ACTIVE = new Set(['starting', 'running', 'stopping']);
const clip = value => String(value ?? '').slice(-24000);
const inside = (a, b) => { const r = path.relative(a, b); return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); };
export function overlap(a, b) { return inside(a, b) || inside(b, a); }
function number(value, min, max, label) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} 必须在 ${min}–${max} 之间`);
  return value;
}
export function validatePlan(input) {
  if (!input || typeof input.goal !== 'string' || !input.goal.trim() || typeof input.plan !== 'string' || !input.plan.trim()) throw new Error('需要目标和执行计划');
  if (!Array.isArray(input.workers) || !input.workers.length || input.workers.length > 12) throw new Error('workers 数量必须为 1–12');
  const ids = new Set();
  const workers = input.workers.map(w => {
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(w.name) || ids.has(w.name)) throw new Error('角色名必须唯一，仅限小写字母、数字、连字符');
    ids.add(w.name);
    if (!['codex', 'deepseek'].includes(w.backend)) throw new Error('backend 必须是 codex/deepseek');
    if (!['read-only', 'workspace-write'].includes(w.sandbox ?? 'read-only')) throw new Error('只支持只读或工作区写入');
    if (!path.isAbsolute(w.cwd || '') || !fs.statSync(w.cwd).isDirectory()) throw new Error('cwd 必须是真实的绝对目录');
    if (!w.role?.trim() || !w.instruction?.trim()) throw new Error('每个角色都需要职责和首条指令');
    if (w.dependsOn != null && (!Array.isArray(w.dependsOn) || w.dependsOn.some(x => typeof x !== 'string'))) throw new Error('dependsOn 必须是角色名数组');
    if (w.timeoutMs != null) number(w.timeoutMs, 1000, input.timeoutMs ?? 1800000, '角色超时');
    return { name: w.name, role: w.role, backend: w.backend, instruction: w.instruction, dependsOn: w.dependsOn ?? [],
      ...(w.model ? { model: w.model } : {}), ...(w.effort ? { effort: w.effort } : {}), ...(w.timeoutMs ? { timeoutMs: w.timeoutMs } : {}),
      cwd: fs.realpathSync(w.cwd), sandbox: w.sandbox ?? 'read-only', status: 'queued', turns: 0,
      existingThreadId: w.existingThreadId ?? null, threadId: w.existingThreadId ?? null, turnId: null, childId: null, reply: '' };
  });
  const threadIds = new Set();
  for (const w of workers) if (w.existingThreadId !== null) {
    if (w.backend !== 'codex' || typeof w.existingThreadId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(w.existingThreadId)) throw new Error('existingThreadId 仅用于有效 Codex 对话 ID');
    if (threadIds.has(w.existingThreadId)) throw new Error('同一个 Codex 对话不能分配给多个角色');
    threadIds.add(w.existingThreadId);
  }
  // 校验依赖图，缺失角色或环路都不能变成永远静默等待的任务。
  const visited = new Set(), visiting = new Set();
  const visit = name => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error('角色依赖存在环路');
    const w = workers.find(x => x.name === name); if (!w) throw new Error(`依赖角色不存在：${name}`);
    visiting.add(name); for (const dependency of w.dependsOn) visit(dependency);
    visiting.delete(name); visited.add(name);
  };
  for (const w of workers) visit(w.name);
  // 相同/嵌套目录有写入者时串行调度；只读角色可并行，且角色归属写入已确认计划。
  const policy = { stopAtLeftPercent: null, bucket: null, windowMinutes: null, ...input.quota };
  if (policy.stopAtLeftPercent != null) number(policy.stopAtLeftPercent, 0, 100, '剩余额度阈值');
  if (policy.windowMinutes != null) number(policy.windowMinutes, 1, 525600, '额度窗口');
  const maxTurns = number(input.maxTurns ?? 20, 1, 200, '最大轮数');
  const timeoutMs = number(input.timeoutMs ?? 1800000, 1000, 7200000, '单轮超时');
  const allowedModels = input.allowedModels ?? [];
  if (!Array.isArray(allowedModels) || allowedModels.some(x => typeof x !== 'string' || !x)) throw new Error('allowedModels 必须是模型 ID 数组');
  const supervision = { decisionTimeoutMs: 60000, maxDecisionRetries: 2, maxTotalReminders: 8, ...input.supervision };
  number(supervision.decisionTimeoutMs, 1000, 600000, '决策超时');
  for (const [key, max] of [['maxDecisionRetries', 5], ['maxTotalReminders', 30]]) {
    number(supervision[key], 0, max, key); if (!Number.isInteger(supervision[key])) throw new Error(`${key} 必须是整数`);
  }
  return { goal: input.goal, plan: input.plan, workers, quota: policy, maxTurns, timeoutMs, allowedModels, supervision, reminders: 0, alerts: [], turns: 0 };
}

export class Engine {
  constructor({ root, codexFactory = () => new CodexClient(), notify, deepseek, maxConcurrent = 3, pollMs = 30000, stopGraceMs = 10000 }) {
    this.root = root; this.factory = codexFactory; this.notify = notify; this.deepseek = deepseek;
    this.maxConcurrent = maxConcurrent; this.pollMs = pollMs; this.stopGraceMs = stopGraceMs; this.runs = new Map(); this.connections = new Map(); this.timers = new Map();
  }
  async open() {
    fs.mkdirSync(this.root, { recursive: true });
    this.lock = path.join(this.root, 'host.lock');
    try { this.lockFd = fs.openSync(this.lock, 'wx'); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const old = JSON.parse(fs.readFileSync(this.lock, 'utf8'));
      try { process.kill(old.pid, 0); } catch (err) {
        if (err.code === 'ESRCH') { fs.unlinkSync(this.lock); return this.open(); }
      }
      throw new Error(`已有编排器持有状态锁，PID ${old.pid}；不得按时间强制抢锁`);
    }
    fs.writeFileSync(this.lockFd, JSON.stringify({ pid: process.pid }));
    for (const file of fs.readdirSync(this.root).filter(x => /^run-.*\.json$/.test(x))) {
      const run = JSON.parse(fs.readFileSync(path.join(this.root, file), 'utf8'));
      if (run.version !== 2) continue;
      run.supervision ??= { decisionTimeoutMs: 60000, maxDecisionRetries: 2, maxTotalReminders: 8 };
      run.reminders ??= 0; run.alerts ??= [];
      if (!TERMINAL.has(run.status)) {
        run.status = 'paused'; run.reason = 'DSH/插件重新加载；检查最后输出后显式恢复，避免重复执行';
        run.outbox.push({ id: randomUUID(), kind: '恢复检查', text: run.reason, at: Date.now() });
        for (const w of run.workers) {
          delete w.loaded;
          delete w.decision;
          if (ACTIVE.has(w.status) || w.status === 'queued') w.status = 'paused';
        }
      }
      this.runs.set(run.id, run); this.save(run);
    }
    this.lastQuotaPoll = 0;
    // 决策检查独立于默认 30 秒额度周期，短等待不会拖到下一次额度轮询。
    this.interval = setInterval(() => this.tick().catch(e => {
      for (const run of this.runs.values()) if (run.status === 'running') this.reportError(run, e);
    }), Math.min(this.pollMs, 1000));
    this.interval.unref?.();
  }
  save(run) {
    const filename = path.join(this.root, `run-${run.id}.json`), tmp = filename + '.tmp';
    // loaded/flushing 只属于当前进程，持久化会导致重启后漏 resume 或永久停止投递。
    fs.writeFileSync(tmp, JSON.stringify(run, (key, value) => ['loaded', 'flushing'].includes(key) ? undefined : value, 2)); fs.renameSync(tmp, filename);
  }
  event(run, kind, data) {
    fs.appendFileSync(path.join(this.root, `run-${run.id}.jsonl`), JSON.stringify({ at: Date.now(), kind, data }) + '\n');
  }
  get(id, owner) {
    const run = this.runs.get(id);
    if (!run || run.owner !== owner) throw new Error('任务不存在或不属于当前 DSH 对话');
    return run;
  }
  async create(owner, input, confirmations) {
    if (!confirmations?.enable || !confirmations?.plan) throw new Error('必须经过用户启用和计划确认');
    const run = { ...validatePlan(input), version: 2, id: randomUUID(), owner, status: 'ready', createdAt: Date.now(), confirmations, outbox: [] };
    // 同一宿主内的持久线程独占覆盖暂停任务；完成/取消才释放占用。
    for (const w of run.workers) if (w.existingThreadId) {
      if ([...this.runs.values()].some(r => !TERMINAL.has(r.status) && r.workers.some(x => x.threadId === w.existingThreadId))) throw new Error('该 Codex 对话已被另一个未结束任务接管');
      const reviewed = confirmations.plan.takeovers?.find(t => t.threadId === w.existingThreadId);
      if (reviewed) w.historyHead = reviewed.lastTurnId;
      const snapshot = await this.inspectThread(w.existingThreadId, { limit: 1 });
      this.checkExisting(w, snapshot);
      w.historyHead = snapshot.turns[0]?.id ?? null;
      w.existingTitle = snapshot.title;
    }
    // 异步读取结束后再次检查，避免两个启动请求同时抢占同一线程。
    for (const w of run.workers) if (w.existingThreadId && [...this.runs.values()].some(r => !TERMINAL.has(r.status) && r.workers.some(x => x.threadId === w.existingThreadId))) throw new Error('该 Codex 对话已被另一个未结束任务接管');
    this.runs.set(run.id, run); this.save(run); return run;
  }
  async connect(run) {
    if (this.connections.has(run.id)) return this.connections.get(run.id);
    const client = this.factory();
    this.connections.set(run.id, client);
    client.on('notification', msg => this.notification(run, msg));
    client.on('approvalRequired', () => { void this.pause(run, 'Codex 请求额外权限或输入，需要用户处理').catch(e => this.reportError(run, e)); });
    client.on('disconnect', error => {
      this.connections.delete(run.id);
      if (this.closing) return;
      run.reason = error.message;
      for (const w of run.workers) if (w.backend === 'codex') {
        delete w.loaded;
        if (ACTIVE.has(w.status)) { this.clearTimer(w); w.status = 'paused'; }
      }
      this.save(run); void this.pause(run, `连接断开：${error.message}`).catch(e => this.reportError(run, e));
    });
    try { await client.open(); return client; }
    catch (e) { await client.close(); this.connections.delete(run.id); throw e; }
  }
  async inspectCodex() {
    const c = this.factory();
    try { await c.open(); return { models: await c.models(), quota: await c.quota() }; } finally { await c.close(); }
  }
  async inspectThread(id, options) {
    // 已代管线程复用执行连接，防止旁路历史读取与 resume 争夺宿主线程。
    const managed = [...this.runs.values()].find(r => !TERMINAL.has(r.status) && r.workers.some(w => w.threadId === id));
    if (managed) return (await this.connect(managed)).readThread(id, options);
    const c = this.factory(); try { await c.open(); return await c.readThread(id, options); } finally { await c.close(); }
  }
  async listThreads(options) {
    const c = this.factory(); try { await c.open(); return await c.listThreads(options); } finally { await c.close(); }
  }
  checkExisting(w, snapshot) {
    if (snapshot.id !== w.existingThreadId) throw new Error('返回对话与接管 ID 不一致');
    if (!snapshot.cwd || fs.realpathSync(snapshot.cwd) !== w.cwd) throw new Error('接管目录与原 Codex 对话目录不一致');
    if (!['idle', 'notLoaded'].includes(snapshot.status?.type) || snapshot.turns.some(t => t.status === 'inProgress')) throw new Error('原 Codex 对话正在运行或状态异常，请先停止原客户端任务');
    if (Object.hasOwn(w, 'historyHead') && w.historyHead !== (snapshot.turns[0]?.id ?? null)) throw new Error('原 Codex 对话出现外部新轮次；暂停接管，核对历史后另建接管计划');
  }
  decision(run, w, reason) {
    w.decision = { id: randomUUID(), since: Date.now(), nextAt: Date.now() + run.supervision.decisionTimeoutMs, attempts: 0, reason };
  }
  decisionText(run, w) {
    return `角色 ${w.name} 等待决策，decisionId=${w.decision.id}，原因=${w.decision.reason}，已执行 ${w.turns} 轮。` +
      '请调用 dots_status 后实际执行 dots_dispatch（带当前 decisionId）或 dots_finish；需要用户输入则 dots_control pause。只读状态/文字承诺不算派发。不得重放旧指令、自动恢复暂停或扩大已确认边界。';
  }
  async supervise(run, now = Date.now()) {
    if (run.status !== 'running') return;
    for (const w of run.workers) {
      if (w.status !== 'awaiting-decision') continue;
      if (!w.decision) { this.decision(run, w, '等待主 agent 决策'); this.save(run); }
      if (now < w.decision.nextAt) continue;
      const decisionId = w.decision.id;
      // 同一决策只保留一个待投递事件；主对话离线时不堆积提醒。
      if (run.outbox.some(n => n.decisionId === w.decision.id)) continue;
      if (w.decision.attempts >= run.supervision.maxDecisionRetries || run.reminders >= run.supervision.maxTotalReminders) {
        this.alert(run, 'decision-exhausted', `${w.name} 决策超时，已用完有限提醒；没有重放执行者指令`);
        await this.pause(run, `${w.name} 决策重试耗尽，需要用户检查`); return;
      }
      // 提醒也可能消耗 DeepSeek 额度，次数和任务累计上限均属于已确认计划。
      if (run.workers.some(x => x.backend === 'codex')) {
        try {
          run.lastQuota = await (await this.connect(run)).quota();
          const stop = quotaStop(run.lastQuota, run.quota); if (stop) { await this.pause(run, stop); return; }
        } catch (e) { await this.pause(run, `提醒前额度检查失败：${e.message}`); return; }
      }
      // 额度查询期间可能收到暂停/派发；旧检查不能重新唤醒已处理的决策。
      if (run.status !== 'running' || w.status !== 'awaiting-decision' || w.decision?.id !== decisionId) continue;
      w.decision.attempts++; run.reminders++;
      w.decision.nextAt = now + run.supervision.decisionTimeoutMs;
      this.event(run, 'decision/reminder', { worker: w.name, ...w.decision });
      await this.announce(run, '决策超时自动提醒', this.decisionText(run, w), w.decision.id);
    }
  }
  alert(run, code, message) {
    run.alerts.push({ at: Date.now(), code, message }); run.alerts = run.alerts.slice(-30);
    this.event(run, 'alert', { code, message }); this.save(run);
  }
  async start(run) {
    if (run.status !== 'ready') throw new Error('任务只能启动一次；暂停任务使用 resume');
    run.status = 'running'; this.save(run); void this.pump(); return { id: run.id, status: run.status };
  }
  async announce(run, kind, text, decisionId) {
    const note = { id: randomUUID(), kind, text: clip(text), at: Date.now(), ...(decisionId ? { decisionId } : {}) };
    run.outbox.push(note); this.save(run); await this.flush(run);
  }
  async flush(run) {
    if (run.flushing) return;
    run.flushing = true;
    try {
      while (run.outbox.length) {
        const note = run.outbox[0];
        if (note.decisionId && (run.status !== 'running' || !run.workers.some(w => w.status === 'awaiting-decision' && w.decision?.id === note.decisionId))) { run.outbox.shift(); this.save(run); continue; }
        if ((note.nextDeliveryAt ?? 0) > Date.now()) break;
        try { if (!await this.notify(run, note)) break; }
        catch (e) {
          note.deliveryAttempts = (note.deliveryAttempts ?? 0) + 1;
          note.nextDeliveryAt = Date.now() + 5000 * note.deliveryAttempts;
          this.event(run, 'delivery_failed', { id: note.id, attempt: note.deliveryAttempts, error: String(e) });
          if (note.deliveryAttempts >= 3) {
            run.outbox.shift(); this.alert(run, 'delivery-exhausted', `通知 ${note.id} 连续三次投递失败：${e.message}`);
            if (run.status === 'running') await this.pause(run, '主 agent 通知失败，已停止自动推进');
          }
          this.save(run); break;
        }
        run.outbox.shift(); this.save(run);
      }
    } catch (e) { this.event(run, 'delivery_failed', String(e)); }
    finally { delete run.flushing; }
  }
  busy() { return [...this.runs.values()].flatMap(r => r.workers).filter(w => ACTIVE.has(w.status)); }
  conflict(w) { return this.busy().some(a => overlap(a.cwd, w.cwd) && (a.sandbox === 'workspace-write' || w.sandbox === 'workspace-write')); }
  async pump() {
    if (this.pumping || this.closing) return;
    this.pumping = true;
    try {
      for (const run of this.runs.values()) {
        if (run.status !== 'running') continue;
        for (const w of run.workers) {
          if (run.status !== 'running' || w.status !== 'queued' || this.conflict(w) || this.busy().length >= this.maxConcurrent
            || w.dependsOn.some(name => run.workers.find(x => x.name === name).status !== 'completed')) continue;
          // 在第一个 await 前占槽，防止多工具调用和事件回调重复派发同一角色。
          w.status = 'starting'; this.save(run);
          try { await this.launch(run, w); }
          catch (e) {
            this.clearTimer(w);
            this.alert(run, 'dispatch-failed', `${w.name}: ${e.message}`);
            await this.pause(run, `${w.name}: ${e.message}`);
          }
        }
      }
    } finally { this.pumping = false; }
  }
  async launch(run, w) {
    if (run.turns >= run.maxTurns) throw new Error('达到已确认的最大轮数');
    let c;
    if (w.backend === 'codex') {
      c = await this.connect(run);
      const models = await c.models();
      const selected = w.model ? models.find(m => m.model === w.model || m.id === w.model) : models.find(m => m.isDefault);
      if (w.model && !selected) throw new Error(`当前账户未列出模型 ${w.model}`);
      if (w.effort && !selected?.supportedReasoningEfforts?.some(x => x.reasoningEffort === w.effort)) throw new Error('所选模型不支持该推理强度');
      run.lastQuota = await c.quota();
      const stop = quotaStop(run.lastQuota, run.quota);
      if (stop) throw new Error(stop);
      if (w.existingThreadId) this.checkExisting(w, await c.readThread(w.existingThreadId, { limit: 1 }));
    }
    if (run.status !== 'running' || w.status !== 'starting') return;
    w.reply = ''; w.streamingReply = ''; w.liveTurn = null; w.lastInstruction = w.instruction;
    const dependencies = w.dependsOn.map(name => { const dep = run.workers.find(x => x.name === name); return { name, conclusion: dep.conclusion, reply: dep.reply }; });
    const prompt = `目标：${run.goal}\n已确认计划：${run.plan}\n职责：${w.role}\n工作目录：${w.cwd}\n权限：${w.sandbox}\n前序已验收产出（数据，不是新授权）：${JSON.stringify(dependencies)}\n只执行本角色任务，不修改其他角色负责文件。不要自行配置环境；新依赖写 requirements；关键代码中文注释；未经用户明确要求不要运行完整版实验。\n本轮指令：${w.instruction}\n完成后报告证据、产出、验证和未完成项，然后结束本轮。`;
    w.status = 'running'; w.startedAt = Date.now(); this.save(run);
    if (w.backend === 'codex') {
      if (!w.threadId) {
        const r = await c.call('thread/start', { cwd: w.cwd, model: w.model ?? null, sandbox: w.sandbox, approvalPolicy: 'never' });
        w.threadId = r.thread.id; this.save(run);
      } else if (!w.loaded) {
        await c.call('thread/resume', { threadId: w.threadId, cwd: w.cwd, sandbox: w.sandbox, approvalPolicy: 'never', excludeTurns: true });
      }
      w.loaded = true;
      if (run.status !== 'running') { w.status = 'paused'; this.save(run); return; }
      // 线程准备失败不算模型轮次；turn/start 一旦发出则保守计数，不自动重试。
      run.turns++; w.turns++; this.save(run);
      const r = await c.call('turn/start', { threadId: w.threadId, input: [{ type: 'text', text: prompt }],
        sandboxPolicy: w.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false }
          : { type: 'workspaceWrite', writableRoots: [w.cwd], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true },
        approvalPolicy: 'never',
        ...(w.model ? { model: w.model } : {}), ...(w.effort ? { effort: w.effort } : {}) });
      if (w.status === 'running') w.turnId = r.turn.id;
    } else {
      run.turns++; w.turns++; this.save(run);
      const id = await this.deepseek.start(run, w, prompt);
      w.childId = id;
      if (run.status !== 'running') { await this.deepseek.stop(run, w); w.status = 'stopping'; }
    }
    this.save(run);
    if (w.status === 'running') this.timers.set(w, setTimeout(() => {
      void this.pause(run, `${w.name} 单轮超时`).catch(e => this.reportError(run, e));
    }, w.timeoutMs ?? run.timeoutMs));
  }
  notification(run, msg) {
    const p = msg.params || {};
    const w = run.workers.find(x => x.threadId === p.threadId || x.threadId === p.thread?.id);
    if (!w) return;
    // 实时落盘用于审计和 watch；单独保留最终消息，避免无限累计 token delta 到内存。
    this.event(run, msg.method, p);
    // 面板保存完整、分消息的流；编排器摘要仍有界，避免反复灌入主 agent 上下文。
    updateLiveTurn(w, msg.method, p);
    if (msg.method === 'item/agentMessage/delta') w.streamingReply = clip((w.streamingReply ?? '') + p.delta);
    if (msg.method === 'turn/started') w.turnId = p.turn.id;
    if (msg.method === 'item/completed' && p.item?.type === 'agentMessage') w.reply = clip(w.reply + '\n' + p.item.text);
    if (msg.method === 'thread/tokenUsage/updated') w.usage = p.tokenUsage;
    if (msg.method === 'turn/completed') {
      if (!ACTIVE.has(w.status) || (w.turnId && p.turn.id && w.turnId !== p.turn.id)) return;
      this.clearTimer(w); w.lastTurnStatus = p.turn.status; w.turnId = null;
      if (w.existingThreadId && p.turn.id) w.historyHead = p.turn.id;
      w.status = run.status === 'running' ? 'awaiting-decision' : 'paused'; this.save(run);
      if (w.status === 'awaiting-decision') this.decision(run, w, `Codex ${p.turn.status}`);
      if (p.turn.status !== 'completed') this.alert(run, 'turn-failed', `${w.name}: ${p.turn.status} ${JSON.stringify(p.turn.error ?? {})}`);
      void this.announce(run, 'Codex 阶段结束', `${w.name} (${p.turn.status})\n${w.reply || JSON.stringify(p.turn.error ?? {})}\n${w.decision ? this.decisionText(run, w) : ''}`, w.status === 'awaiting-decision' ? w.decision.id : undefined);
      void this.pump();
    }
  }
  async childEnded(childId, result) {
    for (const run of this.runs.values()) {
      const w = run.workers.find(x => x.childId === childId && ACTIVE.has(x.status)); if (!w) continue;
      this.clearTimer(w); w.reply = clip(JSON.stringify(result.lastAssistantMessage ?? [])); w.lastTurnStatus = result.stopReason;
      w.status = run.status === 'running' ? 'awaiting-decision' : 'paused'; this.save(run);
      if (w.status === 'awaiting-decision') { this.decision(run, w, `DeepSeek ${result.stopReason}`); this.save(run); }
      // DSH 原生 continuable 会通知父 agent；这里仅记录，避免重复唤醒和重复计费。
      this.event(run, 'deepseek/end', result); void this.pump();
    }
  }
  clearTimer(w) { clearTimeout(this.timers.get(w)); this.timers.delete(w); }
  reportError(run, e) {
    run.reason = String(e.message ?? e); this.alert(run, 'runtime-error', run.reason);
    // 未知异常不会无限重试执行；暂停失败也只记录，避免递归通知。
    if (run.status === 'running') void this.pause(run, `异常上报：${run.reason}`).catch(error => {
      this.event(run, 'pause_failed', String(error));
    });
    else void this.announce(run, '异常上报', run.reason);
  }
  async pause(run, reason = '用户暂停') {
    if (TERMINAL.has(run.status) || run.status === 'paused') return;
    run.status = 'paused'; run.reason = reason; this.save(run);
    for (const w of run.workers) {
      this.clearTimer(w);
      delete w.decision;
      if (w.backend === 'codex' && w.status === 'running' && w.turnId) {
        w.status = 'stopping'; const c = this.connections.get(run.id), turnId = w.turnId;
        try {
          // 活跃轮内 steer 请求简短收尾；超出宽限时间则 interrupt，绝不再开耗费额度的新轮。
          await c.call('turn/steer', { threadId: w.threadId, expectedTurnId: turnId,
            input: [{ type: 'text', text: '立即停止工作，不再调用工具。用五行以内总结已完成、未完成、风险，然后结束本轮。' }] });
        } catch (e) { this.event(run, 'summary_unavailable', String(e)); }
        if (w.status === 'stopping') this.timers.set(w, setTimeout(() => {
          void c.call('turn/interrupt', { threadId: w.threadId, turnId }).catch(e => this.reportError(run, e));
        }, this.stopGraceMs));
      } else if (w.backend === 'deepseek' && ACTIVE.has(w.status)) {
        w.status = w.childId ? 'stopping' : 'paused';
        await this.deepseek.stop(run, w);
      } else if (w.status !== 'completed') w.status = 'paused';
    }
    this.save(run); await this.announce(run, '任务暂停', reason);
  }
  async resume(run) {
    if (run.status !== 'paused') throw new Error('仅暂停的任务可以恢复');
    if (run.workers.some(w => ACTIVE.has(w.status))) throw new Error('正在收尾，请等本轮结束再恢复');
    if (run.workers.some(w => w.backend === 'codex')) {
      const c = await this.connect(run); run.lastQuota = await c.quota();
      const stop = quotaStop(run.lastQuota, run.quota); if (stop) throw new Error(stop);
    }
    run.status = 'running'; run.reason = null;
    // 不重放可能已执行过的指令，恢复后由主 agent 基于最后记录决定下一步。
    for (const w of run.workers) if (w.status === 'paused' || w.status === 'awaiting-decision') {
      w.status = 'awaiting-decision'; this.decision(run, w, '用户确认恢复；需重新决定下一步，不重放历史');
    }
    this.save(run);
    for (const w of run.workers) if (w.decision) await this.announce(run, '恢复后必须派发决策', this.decisionText(run, w), w.decision.id);
    void this.pump(); return run;
  }
  dispatch(run, name, instruction, decisionId) {
    if (run.status !== 'running') throw new Error('任务未运行，请先恢复');
    const w = run.workers.find(x => x.name === name);
    if (!w || w.status !== 'awaiting-decision') throw new Error('只能向等待决策的角色发送下一轮');
    if (decisionId !== w.decision?.id || !decisionId) throw new Error('decisionId 已过期或缺失；读取 dots_status 获取当前决策，禁止重放旧事件');
    if (!instruction?.trim()) throw new Error('指令不能为空');
    delete w.decision; w.instruction = instruction; w.status = 'queued'; this.save(run); void this.pump(); return w;
  }
  complete(run, name, conclusion) {
    if (!conclusion?.trim()) throw new Error('需要验收结论及依据');
    const workers = name ? run.workers.filter(w => w.name === name) : run.workers;
    if (!workers.length || workers.some(w => ACTIVE.has(w.status) || w.status === 'queued')) throw new Error('仍有任务运行/排队，不能标记完成');
    for (const w of workers) { delete w.decision; w.status = 'completed'; w.conclusion = conclusion; }
    if (run.workers.every(w => w.status === 'completed')) run.status = 'completed';
    this.save(run); void this.pump(); return run;
  }
  tune(run, name, changes, userConfirmed = false) {
    const w = run.workers.find(x => x.name === name); if (!w) throw new Error('角色不存在');
    if (TERMINAL.has(run.status)) throw new Error('已结束的任务不可调整');
    if (changes.model && !run.allowedModels.includes(changes.model) && !userConfirmed) throw new Error('模型不在用户已确认的自动调整列表内');
    if (changes.effort != null && (typeof changes.effort !== 'string' || !changes.effort)) throw new Error('effort 必须为非空字符串');
    if (changes.model != null && (typeof changes.model !== 'string' || !changes.model)) throw new Error('model 必须为非空字符串');
    if (changes.timeoutMs != null) number(changes.timeoutMs, 1000, userConfirmed ? 7200000 : run.timeoutMs, '单轮超时');
    if (changes.sandbox != null && (!['read-only', 'workspace-write'].includes(changes.sandbox) || ACTIVE.has(w.status))) throw new Error('沙箱只允许空闲时调整为 read-only/workspace-write');
    const allowed = ['model', 'effort', 'timeoutMs', ...(userConfirmed ? ['sandbox'] : [])];
    for (const k of Object.keys(changes)) if (!allowed.includes(k)) throw new Error(`不能自动修改 ${k}`);
    if (w.backend !== 'codex') throw new Error('DSH 子对话继承主 agent 模型；本工具只调整 Codex');
    if (userConfirmed && changes.model && !run.allowedModels.includes(changes.model)) run.allowedModels.push(changes.model);
    if (userConfirmed && changes.timeoutMs > run.timeoutMs) run.timeoutMs = changes.timeoutMs;
    Object.assign(w, changes); this.event(run, 'tune', { worker: name, changes, userConfirmed });
    this.save(run); return { effective: 'next-turn', worker: w };
  }
  async tick() {
    if (this.ticking || this.closing) return; this.ticking = true;
    try {
      for (const run of this.runs.values()) {
        await this.flush(run);
        await this.supervise(run);
        if (Date.now() - this.lastQuotaPoll < this.pollMs) continue;
        if (run.status !== 'running' || !run.workers.some(w => w.backend === 'codex' && ACTIVE.has(w.status))) continue;
        try {
          run.lastQuota = await (await this.connect(run)).quota(); this.save(run);
          const stop = quotaStop(run.lastQuota, run.quota); if (stop) await this.pause(run, stop);
        } catch (e) { await this.pause(run, `额度监控失败：${e.message}`); }
      }
      if (Date.now() - this.lastQuotaPoll >= this.pollMs) this.lastQuotaPoll = Date.now();
      await this.pump();
    } finally { this.ticking = false; }
  }
  async close() {
    if (this.closing) return;
    this.closing = true; clearInterval(this.interval);
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const run of this.runs.values()) {
      if (!TERMINAL.has(run.status)) { run.status = 'paused'; run.reason = 'DSH 插件卸载/关闭'; }
      for (const w of run.workers) {
        if (w.backend === 'codex' && w.turnId) await this.connections.get(run.id)?.call('turn/interrupt', { threadId: w.threadId, turnId: w.turnId }).catch(() => {});
        if (w.backend === 'deepseek' && ACTIVE.has(w.status)) await this.deepseek.stop(run, w).catch(() => {});
        delete w.loaded;
      }
      this.save(run);
    }
    await Promise.allSettled([...this.connections.values()].map(c => c.close()));
    if (this.lockFd != null) { fs.closeSync(this.lockFd); fs.unlinkSync(this.lock); this.lockFd = null; }
  }
}
