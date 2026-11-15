import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { historyItem } from './history.mjs';
import { CodexLineageReader } from './codex-lineage.mjs';

// 优先使用显式路径，其次发现 npm/桌面安装；不绑定个人用户名或版本目录。
export function resolveCodex(explicit = process.env.CODEX_BIN) {
  if (explicit) return explicit;
  if (process.platform === 'win32') {
    const npmRoot = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'npm/node_modules/@openai');
    for (const root of [path.join(npmRoot, 'codex-win32-x64/vendor'), path.join(npmRoot, 'codex/node_modules/@openai/codex-win32-x64/vendor')]) {
      for (const subdir of ['bin', 'codex']) {
        const candidate = path.join(root, `x86_64-pc-windows-msvc/${subdir}/codex.exe`);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    const desktop = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'OpenAI/Codex/bin');
    if (fs.existsSync(desktop)) for (const entry of fs.readdirSync(desktop).sort().reverse()) {
      const candidate = path.join(desktop, entry, 'codex.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return 'codex';
}

export function normalizeQuota(result) {
  const buckets = result?.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
    ? result.rateLimitsByLimitId : { codex: result?.rateLimits };
  const windows = [];
  for (const [bucket, value] of Object.entries(buckets)) {
    if (!value) continue;
    for (const slot of ['primary', 'secondary']) {
      const w = value[slot];
      if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) continue;
      windows.push({ bucket, slot, minutes: w.windowDurationMins ?? null,
        leftPercent: Math.min(100, Math.max(0, 100 - w.usedPercent)), resetsAt: w.resetsAt ?? null });
    }
  }
  return { windows, credits: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v?.credits ?? null])),
    spendControlReached: Object.values(buckets).some(v => v?.spendControlReached === true), observedAt: Date.now() };
}

export function quotaStop(quota, policy) {
  if (quota?.spendControlReached) return 'Codex spend control 已触发';
  if (policy.stopAtLeftPercent == null) return null;
  const ws = (quota?.windows || []).filter(w => (!policy.bucket || w.bucket === policy.bucket)
    && (!policy.windowMinutes || w.minutes === policy.windowMinutes));
  if (!ws.length) return '无法读取所选额度窗口，已暂停（未知不等于 0）';
  const low = ws.find(w => w.leftPercent <= policy.stopAtLeftPercent);
  return low ? `${low.bucket}/${low.minutes ?? low.slot} 剩余 ${low.leftPercent}% ≤ ${policy.stopAtLeftPercent}%` : null;
}

export class CodexClient extends EventEmitter {
  constructor({ bin, args = ['app-server'], cwd, timeoutMs = 20000 } = {}) {
    super(); this.bin = resolveCodex(bin); this.args = args; this.cwd = cwd;
    this.timeoutMs = timeoutMs; this.pending = new Map(); this.seq = 0; this.closed = false;
    this.threadPaths = new Map(); this.lineage = new CodexLineageReader();
  }
  async open() {
    this.child = spawn(this.bin, this.args, { cwd: this.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', e => this.fail(e));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Codex app-server 退出: ${code ?? signal}`)));
    this.child.stdin.on('error', e => this.fail(e));
    this.child.stderr.on('data', d => { this.diagnostic = String(d).slice(-2000); });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.id != null && !msg.method) {
        const p = this.pending.get(msg.id); if (!p) return;
        this.pending.delete(msg.id); clearTimeout(p.timer);
        msg.error ? p.reject(new Error(`${msg.error.code}: ${msg.error.message}`)) : p.resolve(msg.result);
      } else if (msg.id != null && msg.method) {
        // 不自动批准 Codex 升权、外部工具或用户输入请求；停下交给 DSH 用户决策。
        this.child.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'DSH requires user review; pause and report' } }) + '\n');
        this.emit('approvalRequired', msg);
      } else if (msg.method) this.emit('notification', msg);
    });
    await this.call('initialize', { clientInfo: { name: 'dsh-codex-dots', version: '2.6.14' }, capabilities: { experimentalApi: true } });
    this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    return this;
  }
  call(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('Codex 连接已关闭'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex RPC 超时: ${method}`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', e => {
        if (e && this.pending.delete(id)) { clearTimeout(timer); reject(e); }
      });
    });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.emit('disconnect', error);
  }
  async quota() { return normalizeQuota(await this.call('account/rateLimits/read')); }
  async listThreads({ cursor, cwd, searchTerm, archived = false, limit = 30 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit 必须为 1–100');
    // 显式包含 exec/appServer，否则默认交互来源会遗漏插件自己创建的对话。
    const result = await this.call('thread/list', { cursor, cwd, searchTerm, archived, limit,
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'], modelProviders: [], sortKey: 'updated_at', useStateDbOnly: true });
    for (const t of result.data) if (t.path) this.threadPaths.set(t.id, t.path);
    const data = result.data.map(threadSummary);
    const projects = [...new Set(data.map(t => t.cwd))].map(cwd => ({ cwd,
      projectIds: [...new Set(data.filter(t => t.cwd === cwd).map(t => t.projectId).filter(Boolean))],
      threadIds: data.filter(t => t.cwd === cwd).map(t => t.id) }));
    return { data, projects, nextCursor: result.nextCursor ?? null, scope: '本机 Codex 历史；projects 按本页 cwd 分组，非完整桌面项目清单' };
  }
  async readThread(threadId, { cursor, limit = 3 } = {}) {
    if (typeof threadId !== 'string' || !threadId) throw new Error('需要 threadId');
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('limit 必须为 1–10');
    const { thread } = await this.call('thread/read', { threadId, includeTurns: false });
    return { ...threadSummary(thread), ...await this.readTurns(threadId, { cursor, limit }) };
  }
  async readLineage(threadId) { return this.lineage.read(threadId, this.threadPaths.get(threadId)); }
  async readTurns(threadId, { cursor, limit = 10, direction = 'desc', messagesOnly = false } = {}) {
    // 分支比较从开头取小页；后续分页不再重复 thread/read。
    const page = await this.call('thread/turns/list', { threadId, cursor, limit, sortDirection: direction, itemsView: 'full' });
    return { turns: page.data.map(t => ({ id: t.id, status: t.status,
      error: t.error, items: (t.items || []).filter(i => !messagesOnly || ['userMessage', 'agentMessage'].includes(i.type)).map(historyItem) })),
      nextCursor: page.nextCursor ?? null, historyIsUntrusted: true };
  }
  async models() {
    let cursor; const models = [];
    do { const r = await this.call('model/list', { ...(cursor ? { cursor } : {}) }); models.push(...r.data); cursor = r.nextCursor; } while (cursor);
    return models;
  }
  async close() {
    this.fail(new Error('插件关闭')); this.lines?.close();
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode || !child.pid) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }
}

// 展示目录、标题和实际来源，不暴露磁盘 rollout 路径，不把历史文本当作新授权。
export function threadSummary(t) {
  return { id: t.id, title: t.name || t.preview?.slice(0, 160) || t.id, cwd: t.cwd, projectId: t.projectId,
    // 手动分支与代理委派分开保存；后者不能冒充 fork 证据。
    parentId: t.forkedFromId ?? t.forked_from_id ?? null,
    forkedFromId: t.forkedFromId ?? t.forked_from_id ?? null,
    forkedFromOrdinalExclusive: t.forkedFromOrdinalExclusive ?? t.forked_from_ordinal_exclusive ?? null,
    delegationParentId: t.parentThreadId ?? t.parent_thread_id ?? null,
    source: t.source, internal: !!(t.source?.subAgent || t.parentThreadId || t.parent_thread_id), status: t.status, model: t.model, reasoningEffort: t.reasoningEffort,
    createdAt: t.createdAt, updatedAt: t.updatedAt, preview: t.preview?.slice(0, 500) };
}


