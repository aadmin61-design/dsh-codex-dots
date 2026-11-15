import { CodexClient } from './codex.mjs';
import { ConversationTree } from './conversation-tree.mjs';
import { STANDALONE } from './conversation-tree.mjs';
import { ConversationDeletion } from './conversation-delete.mjs';

// 所有面板请求经过 DSH connection 的认证，不另开无认证本地服务。
export function installPanelApi(ctx, engine, { clientFactory = () => new CodexClient(), continueInParent, conversations } = {}) {
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
  const library = () => { const service = conversations?.(); if (!service) throw Error('对话树需要 DSH 0.2.2-rc.3 的原生会话与工作区服务'); return service; };
  let deletion;
  const deletions = () => {
    const service = library();
    if (deletion?.service !== service) deletion = new ConversationDeletion(service, engine);
    return deletion;
  };
  const treeNode = async input => {
    const node = (await (input.project === STANDALONE ? library().treeState(input.project) : new ConversationTree(input.project).read())).nodes.find(n => n.key === input.key);
    if (!node) throw Error('对话节点不存在，请刷新树'); return node;
  };
  function route(name, methods, fn) {
    registrations.push(ctx.connection.fetch.register({ path: '/api/codex-dots/' + name, methods, requestBody: 'buffered',
      async fetch(request) {
        try {
          const url = new URL(request.url);
          const input = request.method === 'POST' ? await request.json() : Object.fromEntries(url.searchParams);
          if (input.project === STANDALONE && request.method === 'POST' && !['conversation-sync', 'continue', 'conversation-dots'].includes(name)) {
            throw Error('独立对话分组没有工作区目录');
          }
          const result = await fn(input, request.signal);
          return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
        } catch (error) { return Response.json({ error: error.message }, { status: 400, headers: { 'Cache-Control': 'no-store' } }); }
      } }));
  }
  route('threads', ['GET'], async input => (await connect()).listThreads({
    limit: 50, ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.searchTerm ? { searchTerm: input.searchTerm } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}), archived: input.archived === 'true',
  }));
  // 通过已有目录接口报告后端能力，识别前端已更新但宿主尚未重载的情况。
  route('conversation-projects', ['GET'], async () => ({ ...await library().projects(), pluginVersion: '2.6.11', capabilities: ['permanent-delete-v1'] }));
  route('conversation-tree', ['GET'], input => library().autoSummary(input.project, input.owner));
  route('conversation-sync', ['POST'], input => library().requestSync(input.project, input.includeArchived));
  route('conversation-copy', ['POST'], input => library().startCopy(input.project));
  route('conversation-delete-plan', ['POST'], input => deletions().prepare(input));
  route('conversation-delete-confirm', ['POST'], input => deletions().confirm(input));
  route('conversation-history', ['GET'], async (input, signal) => {
    try { return await library().history(await treeNode(input), signal); }
    catch (e) { if (!signal.aborted) await library().markUnavailable(input.project, input.key, e); throw e; }
  });
  route('conversation-create', ['POST'], async input => {
    const result = await library().create(input.project, input);
    if (input.parentKey && input.summarize) {
      try { result.tree = await library().summarize(input.project, result.key, input.owner); }
      catch (error) { result.summaryError = error.message; }
    }
    return result;
  });
  route('conversation-link', ['POST'], async input => new ConversationTree(input.project).link(input.key, input.parentKey, input.intent));
  route('conversation-summary', ['POST'], input => library().summarize(input.project, input.key, input.owner));
  route('conversation-settings', ['POST'], input => new ConversationTree(input.project).change(tree => { tree.autoSummaries = input.autoSummaries === true; }));
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
      workers: r.workers.map(w => ({ name: w.name, backend: w.backend, threadId: w.threadId, childId: w.childId,
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
  route('conversation-dots', ['POST'], async input => {
    const parent = ownerOf(input.owner), node = await treeNode(input);
    if (typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 6000) throw Error('请填写目标（最多 6000 字）');
    await continueInParent(parent, { thread: { id: node.id, cwd: node.cwd || input.project, group: input.project, backend: 'deepseek' }, goal: input.goal.trim() });
    return { ok: true, message: '已交给 DeepSeek 主对话制定计划；执行前仍需确认' };
  });
  return { present, connect, async close() { registrations.reverse().forEach(dispose => dispose()); await opening?.catch(() => {}); await client?.close(); } };
}
