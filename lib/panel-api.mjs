import { CodexClient } from './codex.mjs';

// 所有面板请求经过 DSH connection 的认证，不另开无认证本地服务。
export function installPanelApi(ctx, engine, { clientFactory = () => new CodexClient(), continueInParent } = {}) {
  const hints = new Map();
  let client, opening;
  const connect = async () => {
    if (client && !client.closed) return client;
    if (opening) return opening;
    opening = (async () => { const c = clientFactory(); try { await c.open(); client = c; return c; } catch (e) { await c.close(); throw e; } })();
    try { return await opening; } finally { opening = null; }
  };
  const present = (owner, view) => hints.set(owner, { ...view, revision: Date.now() });
  const ownerOf = value => {
    if (typeof value !== 'string' || !value || value.length > 200) throw new Error('请先打开一个 DSH 主对话');
    const parent = ctx.agents.get(value);
    if (!parent || parent.session.header.origin === 'subagent') throw new Error('请先打开对应的 DSH 主对话');
    return parent;
  };
  const registrations = [];
  function route(name, methods, fn) {
    registrations.push(ctx.connection.fetch.register({ path: '/api/codex-dots/' + name, methods, requestBody: 'buffered',
      async fetch(request) {
        try {
          const url = new URL(request.url);
          const input = request.method === 'POST' ? await request.json() : Object.fromEntries(url.searchParams);
          const result = await fn(input, request.signal);
          return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
        } catch (error) { return Response.json({ error: error.message }, { status: 400, headers: { 'Cache-Control': 'no-store' } }); }
      } }));
  }
  route('threads', ['GET'], async input => (await connect()).listThreads({
    limit: 50, ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.searchTerm ? { searchTerm: input.searchTerm } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}), archived: input.archived === 'true',
  }));
  const read = async (id, options) => {
    if (engine.inspectThread) return engine.inspectThread(id, options);
    return (await connect()).readThread(id, options);
  };
  route('thread', ['GET'], async input => read(input.threadId, { limit: 10, ...(input.cursor ? { cursor: input.cursor } : {}) }));
  route('state', ['GET'], async input => {
    if (!input.owner) return { runs: [], hint: null };
    const runs = [...engine.runs.values()].filter(r => r.owner === input.owner).sort((a, b) => a.createdAt - b.createdAt).map(r => ({
      id: r.id, goal: r.goal, status: r.status, reason: r.reason, turns: r.turns, maxTurns: r.maxTurns,
      quota: r.quota, lastQuota: r.lastQuota, reminders: r.reminders, alerts: r.alerts,
      workers: r.workers.filter(w => w.backend === 'codex').map(w => ({ name: w.name, threadId: w.threadId,
        status: w.status, model: w.model, effort: w.effort, sandbox: w.sandbox, reply: w.reply,
        liveTurn: w.liveTurn ?? null, streamingReply: w.streamingReply ?? '', instruction: w.lastInstruction, turnId: w.turnId })),
    }));
    return { runs, hint: hints.get(input.owner) ?? null };
  });
  route('continue', ['POST'], async input => {
    const parent = ownerOf(input.owner);
    if (typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 6000) throw new Error('请填写继续目标（最多 6000 字）');
    const thread = await read(input.threadId, { limit: 1 });
    // 点击仅向 DeepSeek 提交目标；真正续接仍由 dots_start 双确认与额度闸门控制。
    const held = [...engine.runs.values()].find(r => !['completed', 'cancelled'].includes(r.status) && r.workers.some(w => w.threadId === thread.id));
    if (held && held.owner !== input.owner) throw new Error('此对话已由另一个 DSH 主对话代管，请先结束原任务');
    await continueInParent(parent, { thread, goal: input.goal.trim(), run: held });
    present(input.owner, { kind: 'thread', threadId: thread.id });
    return { ok: true, threadId: thread.id, message: '目标已交给 DeepSeek；Codex 执行仍需确认计划' };
  });
  return { present, async close() { registrations.reverse().forEach(dispose => dispose()); await opening?.catch(() => {}); await client?.close(); } };
}
