// 在本机 DSH 的 Electron Node 中验证原生历史格式；持久化和模型采用隔离替身，不操作用户对话。
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

async function main() {
  const runtime = process.argv[2];
  const hook = registerHooks({ resolve(specifier, context, next) {
    return next(specifier, specifier.startsWith('@deepseek-ai/') ? { ...context, parentURL: pathToFileURL(path.join(runtime, 'package.json')).href } : context);
  } });
  const { Session, SESSION_FORMAT_VERSION } = await import('@deepseek-ai/dsh-session');
  const { assertV4RowAdmission } = await import('@deepseek-ai/dsh-session-format-v3-to-v4');
  const { DshConversations } = await import(pathToFileURL(path.resolve(__dirname, '../lib/dsh-conversations.mjs')));
  const { ConversationTree } = await import(pathToFileURL(path.resolve(__dirname, '../lib/conversation-tree.mjs')));
  const project = await fs.mkdtemp(path.resolve(__dirname, '../.runtime/tree-smoke-'));
  const records = new Map(), attached = [], calls = [];
  const workspace = { id: 'fixture-project', path: project, title: '隔离测试', attachSession: async id => { attached.push(id); } };
  const ctx = {
    workspaceRegistry: { list: () => [workspace], create: async () => workspace, archivedSessionIds: [] },
    agents: { get: () => undefined }, get: () => undefined, logger: { warn() {} },
    sessionQuery: {
      listSessions: async () => [...records.values()].map(r => ({ header: r.session })),
      readTitleSnapshots: async ids => ids.map(id => ({ status: 'fulfilled', value: { session: records.get(id).session, title: { title: '已有DSH对话' } } })),
      readSession: async id => records.get(id),
    },
    sessionPersistence: { create: async header => {
      const record = { session: header, events: [] }; records.set(header.id, record);
      return { append: async events => { for (const event of events) assertV4RowAdmission(event); record.events.push(...events); }, flush: async () => {}, close: async () => {} };
    } },
    sessionController: {
      create: async () => { calls.push('create'); return { sessionId: 'blank-dsh' }; },
      fork: async request => { calls.push(['fork', request]); return { sessionId: 'fork-dsh' }; },
      rename: async () => {},
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-fixture', model: 'fixture' }) },
    llm: { prepareCall: async () => ({ config: {}, async *stream(options) {
      assert.match(options.system, /分支意图/); assert.equal(options.tools, undefined); calls.push('summary');
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '迁移历史以继续探索' } }; yield { type: 'finish', reason: { kind: 'stop' } };
    } }) },
  };
  const full = '正文开始' + '历史内容'.repeat(2000) + '正文结束';
  const codex = {
    listThreads: async ({ archived }) => ({ data: archived ? [] : [{ id: 'cx-source', cwd: project, title: '来源', parentId: null }], nextCursor: null }),
    readThread: async (_id, { cursor }) => ({ id: 'cx-source', cwd: project, title: '来源', model: 'fixture', nextCursor: cursor ? null : 'older', turns: cursor ? [{ id: 'old', status: 'completed', items: [{ type: 'userMessage', text: '原问题' }, { type: 'agentMessage', text: full }, { type: 'commandExecution', text: '历史输出' }] }] : [{ id: 'new', status: 'completed', items: [{ type: 'userMessage', text: '后续问题' }, { type: 'agentMessage', text: '后续回答' }] }] }),
  };
  const service = new DshConversations(ctx, async () => codex);
  try {
    await service.sync(project, true);
    const result = await service.create(project, { parentKey: 'codex:cx-source', title: '迁移', intent: '转入DSH继续' });
    const record = records.get(result.sessionId);
    assert.equal(record.session.version, SESSION_FORMAT_VERSION);
    Session.create(result.sessionId, record.events, record.session);
    assert.equal(attached[0], result.sessionId); assert.equal(record.events.some(e => e.type === 'tool/call'), false);
    assert.ok(record.events.some(e => JSON.stringify(e).includes(full)));
    const preview = await service.history({ source: 'dsh', id: result.sessionId });
    assert.equal(preview.messages[0].text, '原问题'); assert.equal(preview.messages.at(-1).text, '后续回答');
    await service.summarize(project, result.key);
    const fork = await service.create(project, { parentKey: result.key, title: 'DSH分支', intent: '另一种思路' });
    assert.equal(fork.tree.nodes.find(n => n.key === fork.key).depth, 3);
    assert.equal(calls.find(c => Array.isArray(c))[1].sessionId, result.sessionId);
    assert.equal(calls.find(c => Array.isArray(c))[1].atSeq, record.events.at(-1).seq);
    const blank = await service.create(project, { title: '从零开始' });
    assert.equal(blank.tree.nodes.find(n => n.key === blank.key).depth, 1);
    const updated = await new ConversationTree(project).read();
    assert.equal(updated.nodes.find(n => n.key === result.key).reason, '迁移历史以继续探索');
    // 摘要失败不删除迁移结果、不偷偷重试模型。
    ctx.llm.prepareCall = async () => { throw Error('模拟模型失败'); };
    await assert.rejects(service.summarize(project, fork.key), /模拟模型失败/);
    const after = await new ConversationTree(project).read();
    assert.equal(after.nodes.find(n => n.key === fork.key).reasonStatus, 'error');
    assert.equal(calls.filter(c => c === 'summary').length, 1);
    console.log(JSON.stringify({ ok: true, checks: ['真实 DSH Session/v4 历史准入', '完整分页与8000字正文', '迁移保留源与原始快照', '原生DSH分支参数', '深度1/2/3', 'DeepSeek摘要流替身与失败状态'] }));
  } finally { await service.close(); hook.deregister(); await fs.rm(project, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
