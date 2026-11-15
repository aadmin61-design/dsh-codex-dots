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
  const fixtureRoot = await fs.mkdtemp(path.resolve(__dirname, '../.runtime/tree-smoke-'));
  const project = path.join(fixtureRoot, 'registered');
  const restoredProject = path.join(fixtureRoot, 'restored');
  const scratch = path.join(fixtureRoot, 'Codex', '2026-11-15', 'chat');
  await fs.mkdir(project);
  await fs.mkdir(restoredProject);
  await fs.mkdir(scratch, { recursive: true });
  const records = new Map(), attached = [], calls = [];
  const workspace = { get sessionIds() { return [...records.keys()].filter(id => !['independent-dsh', 'default-dsh', 'ghost-draft', 'ghost-broken'].includes(id)); }, id: 'fixture-project', path: project, title: '隔离测试', attachSession: async id => { attached.push(id); } };
  const ctx = {
    workspaceRegistry: {
      list: () => [workspace, { id: 'default', title: '已重命名', path: scratch, sessionIds: ['default-dsh'] }],
      requireState: () => ({ defaultWorkspaceId: 'default' }), create: async () => workspace, archivedSessionIds: [] },
    agents: { get: () => undefined }, get: () => undefined, logger: { warn() {} },
    sessionQuery: {
      listSessions: async () => [...records.values()].map(r => ({ header: r.session })),
      readTitleSnapshots: async ids => ids.map(id => ({ status: 'fulfilled', value: { session: records.get(id).session, title: id.startsWith('ghost-') ? undefined : { title: '已有DSH对话' } } })),
      readSession: async id => records.get(id),
    },
    sessionPersistence: {
      stat: async id => records.has(id) ? { header: records.get(id).session, revision: String(records.get(id).events.length) } : undefined,
      open: async id => ({ read: async (offset, length) => { if (id === 'ghost-broken') throw Error('stored log is corrupt'); return { events: records.get(id).events.slice(offset, offset + length) }; }, close: async () => {} }),
      create: async header => {
      const record = { session: header, events: [] }; records.set(header.id, record);
      return { append: async events => { for (const event of events) assertV4RowAdmission(event); record.events.push(...events); }, flush: async () => {}, close: async () => {} };
    } },
    sessionController: {
      create: async () => { calls.push('create'); records.set('blank-dsh', { session: { version: SESSION_FORMAT_VERSION, id: 'blank-dsh', cwd: project, createdAt: Date.now() }, events: [] }); return { sessionId: 'blank-dsh' }; },
      fork: async request => { calls.push(['fork', request]); const source = records.get(request.sessionId); records.set('fork-dsh', { session: { ...source.session, id: 'fork-dsh', createdAt: Date.now(), isSeeded: true }, events: source.events.slice() }); return { sessionId: 'fork-dsh' }; },
      rename: async () => {},
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-fixture', model: 'fixture' }) },
    llm: { prepareCall: async config => { assert.equal(config.reasoningEffort,'off');assert.equal(config.maxTokens,512);return { config, async *stream(options) {
      assert.match(options.system, /分支意图/); assert.equal(options.tools, undefined); calls.push('summary');
      assert.equal(options.reasoningEffort,'off');
      yield { type: 'block-start', index: 0, blockType:'text' };yield { type:'text-delta', index:0, text:'迁移历史以' };yield { type:'text-delta', index:0, text:'继续探索' }; yield { type: 'finish', reason: { kind: 'stop' } };
    } };} },
  };
  const full = '正文开始' + '历史内容'.repeat(2000) + '正文结束';
  const codex = {
    listThreads: async ({ archived }) => ({ data: archived ? [] : [{ id: 'cx-source', cwd: project, title: '来源', parentId: null }], nextCursor: null }),
    readThread: async (_id, { cursor }) => ({ id: 'cx-source', cwd: project, title: '来源', model: 'fixture', nextCursor: cursor ? null : 'older', turns: cursor ? [{ id: 'old', status: 'completed', items: [{ type: 'userMessage', text: '原问题' }, { type: 'agentMessage', text: full }, { type: 'commandExecution', text: '历史输出' }] }] : [{ id: 'new', status: 'completed', items: [{ type: 'userMessage', text: '后续问题' }, { type: 'agentMessage', text: '后续回答' }] }] }),
  };
  codex.readTurns = async (id, options) => codex.readThread(id, options);
  const listThreads = codex.listThreads;
  codex.listThreads = async options => {
    const page = await listThreads(options);
    if (!options.archived) page.data.push(
      { id: 'independent-codex', cwd: project, projectId: null, title: '独立 Codex' },
      { id: 'native-moved', cwd: path.join(project, '以前的目录'), projectId: 'native-id', title: '原生移动', forkedFromId: 'cx-source' },
      { id: 'desktop-moved', cwd: path.join(project, '以前的目录'), projectId: null, title: '桌面归属', forkedFromId: 'cx-source' },
      { id: 'secondary-root', cwd: path.toNamespacedPath(path.join(project, '另外的根', '子目录')), projectId: null, title: '旧版目录匹配', forkedFromId: 'cx-source' },
      { id: 'unassigned', cwd: path.join(fixtureRoot, '无项目目录'), projectId: null, title: '无项目' },
      { id: 'recovered-codex', cwd: path.toNamespacedPath(restoredProject), title: '恢复的项目对话' },
      { id: 'scratch-codex', cwd: path.toNamespacedPath(scratch), title: '日期临时目录' },
    );
    return page;
  };
  records.set('independent-dsh', { session: { id: 'independent-dsh', cwd: project, createdAt: Date.now() }, events: [] });
  records.set('default-dsh', { session: { id: 'default-dsh', cwd: scratch, createdAt: Date.now() }, events: [] });
  for (const id of ['ghost-draft', 'ghost-broken']) records.set(id, { session: { id, cwd: scratch, createdAt: Date.now() }, events: [] });
  const readCodexState = async () => ({
    'local-projects': {
      legacy: { name: '测试项目', rootPaths: [project, path.join(project, '另外的根')] },
      prefix: { name: '前缀测试', rootPaths: [path.join(project, 'prefix-project')] },
    },
    'app-server-project-id-by-legacy-project-id-by-host': { local: { legacy: 'native-id' } },
    'thread-project-assignments': { 'desktop-moved': { projectKind: 'local', projectId: 'legacy' } },
    'projectless-thread-ids': ['independent-codex', 'native-moved'],
  });
  const service = new DshConversations(ctx, async () => codex, { readCodexState });
  try {
    // 同目录的独立会话仍归入独立分组，刷新后不会在项目树重复显示。
    const directory = await service.projects();
    assert.deepEqual(directory.projects.filter(p => p.standalone).map(p => [p.title, p.count]), [['Codex 独立对话', 3], ['DSH 独立对话', 2]]);
    const codexGroup = await service.treeState('standalone-conversations:codex');
    assert.deepEqual(new Set(codexGroup.nodes.map(n => n.id)), new Set(['independent-codex', 'unassigned', 'scratch-codex']));
    const dshGroup = await service.treeState('standalone-conversations:dsh');
    assert.deepEqual(new Set(dshGroup.nodes.filter(n => !n.empty && !n.unavailable).map(n => n.id)), new Set(['independent-dsh', 'default-dsh']));
    assert.equal(dshGroup.nodes.find(n => n.id === 'ghost-draft').empty, true);
    assert.match(dshGroup.nodes.find(n => n.id === 'ghost-broken').unavailable, /corrupt/);
    assert.ok(!directory.projects.some(p => p.path === scratch));
    assert.equal(directory.projects.find(p => p.path === restoredProject).count, 1);
    assert.deepEqual((await service.sync(restoredProject, true)).nodes.map(n => n.id), ['recovered-codex']);
    const indexed = await service.sync(project, true);
    assert.deepEqual(new Set(indexed.nodes.map(n => n.id)), new Set(['cx-source', 'native-moved', 'desktop-moved', 'secondary-root']));
    assert.ok(!directory.projects.some(p => p.path === path.join(project, '另外的根')));

    // 用户关闭窗口后，正在返回的 Codex 分页不会发起下一次读取。
    const abort = new AbortController();
    const firstPage = codex.readThread;
    codex.readThread = async (...args) => {
      const page = await firstPage(...args);
      abort.abort();
      return page;
    };
    await assert.rejects(service.history({ source: 'codex', id: 'independent-codex' }, abort.signal), { name: 'AbortError' });
    codex.readThread = firstPage;
    codex.listThreads = listThreads;
    service.codexDirectories.clear();
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
    // reasoning 预算耗尽和空正文都如实报错，不把思考内容伪装成分支原因。
    ctx.llm.prepareCall=async()=>({config:{},async *stream(){yield {type:'reasoning-delta',index:0,text:'思考中'};yield {type:'finish',reason:{kind:'max-tokens'}};}});
    await assert.rejects(service.summarize(project,fork.key),/输出上限/);
    ctx.llm.prepareCall=async()=>({config:{},async *stream(){yield {type:'finish',reason:{kind:'stop'}};}});
    await assert.rejects(service.summarize(project,fork.key),/空正文/);
    // 整个项目通过宿主工作区接口登记；重复同步不会重复导入已映射历史。
    const before = records.size, progress = service.startCopy(project);
    assert.equal(service.startCopy(project), progress);
    await service.copies.get(path.resolve(project)).task;
    assert.equal(progress.running, false); assert.deepEqual(progress.errors, []);
    assert.equal(records.size, before + 1);
    let copied = await new ConversationTree(project).read();
    const origin = copied.nodes.find(n => n.key === 'codex:cx-source');
    assert.ok(origin.dshSessionId); assert.ok(attached.includes(origin.dshSessionId));
    const mirror = copied.nodes.find(n => n.id === origin.dshSessionId);
    assert.equal(mirror.mirrorOf, origin.key); assert.equal(mirror.depth, origin.depth);
    assert.equal(copied.workspaceId, workspace.id);
    const count = records.size;
    service.startCopy(project); await service.copies.get(path.resolve(project)).task;
    assert.equal(records.size, count); assert.ok(attached.includes('blank-dsh'));
    assert.equal((await service.autoSummary(project)).copy.running, false);
    // 临时会话不访问历史，后台子代理保留元数据但从普通项目计数中排除。
    records.set('selectionchat-temp-fixture', { session: { id:'selectionchat-temp-fixture',cwd:project,createdAt:1 },events:[] });
    records.set('internal-worker', { session: { id:'internal-worker',cwd:project,createdAt:2,origin:'subagent',parentSession:'blank-dsh' },events:[] });
    records.set('broken', { session: { id:'broken',cwd:project,createdAt:Date.now()+100 },events:[] });
    const originalOpen=ctx.sessionPersistence.open;
    ctx.sessionPersistence.open=async id=>{ if(id==='selectionchat-temp-fixture')throw Error('临时会话不应被打开');if(id==='broken')throw Error('stored session is corrupt: wrong Session');return originalOpen(id); };
    await service.sync(project,true);
    const filtered=await service.treeState(project);
    assert.ok(!filtered.nodes.some(n=>n.id==='selectionchat-temp-fixture'));
    assert.equal(filtered.nodes.find(n=>n.id==='internal-worker').internal,true);
    assert.match(filtered.nodes.find(n=>n.id==='broken').unavailable,/corrupt/);
    // 空白记录只含初始化事件时隐藏；日志没变不重读，新消息到达后重新展示。
    const emptyFile=path.join(project,'empty-fixture.log');await fs.writeFile(emptyFile,'initial');
    const originalStat=ctx.sessionPersistence.stat;let emptyReads=0;
    records.set('empty-fixture',{session:{id:'empty-fixture',cwd:project,createdAt:Date.now()+200},events:[]});
    ctx.sessionPersistence.stat=async id=>id==='empty-fixture'?{header:records.get(id).session,location:{path:emptyFile}}:originalStat(id);
    const checkedOpen=ctx.sessionPersistence.open;
    ctx.sessionPersistence.open=async id=>{if(id==='empty-fixture')emptyReads++;return checkedOpen(id);};
    let emptyTree=await service.sync(project,true);
    assert.equal(emptyTree.nodes.find(n=>n.id==='empty-fixture').empty,true);
    const readCount=emptyReads;
    await service.sync(project,true);assert.equal(emptyReads,readCount);
    records.get('empty-fixture').events=record.events.slice();await fs.appendFile(emptyFile,'new message');
    emptyTree=await service.sync(project,true);
    assert.equal(emptyTree.nodes.find(n=>n.id==='empty-fixture').empty,false);
    assert.ok(emptyReads>readCount);
    // 前台请求无需等待目录或正文加载完成。
    const originalList=codex.listThreads;let release;
    service.codexDirectories.clear();
    codex.listThreads=async options=>{await new Promise(resolve=>{release=resolve;});return originalList(options);};
    const cached=await service.requestSync(project,false);
    assert.ok(cached.nodes.length>0);assert.equal(cached.loading.running,true);
    while(!release)await new Promise(r=>setTimeout(r,1));release();
    await service.jobs.get(path.resolve(project)).task;codex.listThreads=originalList;
    // 持久分支缓存跨服务重启复用；只读前缀，绝不调用全历史接口。
    const cachedProject=path.join(project,'prefix-project');await fs.mkdir(cachedProject);
    let pages=0;
    const prefixClient={listThreads:async({archived})=>({data:archived?[]:['a','b'].map((id,i)=>({id,cwd:cachedProject,title:id,createdAt:i+1,updatedAt:10})),nextCursor:null}),
      readThread:async()=>{throw Error('索引不能读取完整历史');},
      readTurns:async(id,options)=>{assert.equal(options.direction,'asc');pages++;return {turns:[{items:[{id:'u',type:'userMessage',text:'共同问题'.repeat(30)},{id:'a',type:'agentMessage',text:'共同回答'.repeat(30)},{id,type:'userMessage',text:id}]}],nextCursor:'不应读取的尾页'};}};
    const first=new DshConversations(ctx,async()=>prefixClient,{ readCodexState });
    await first.sync(cachedProject,true);assert.equal(pages,2);await first.close();
    const second=new DshConversations(ctx,async()=>prefixClient,{ readCodexState });
    await second.sync(cachedProject,true);assert.equal(pages,2);
    assert.equal(second.jobs.get(path.resolve(cachedProject)).progress.reused,1);
    ctx.agents.list=()=>[{status:'running'}];second.queue=[cachedProject];
    await second.preloadNext();assert.equal(second.queue.length,1);
    ctx.agents.list=()=>[];await second.preloadNext();assert.equal(second.queue.length,0);
    prefixClient.readLineage=async id=>id==='b'?{id,forked_from_id:'a',forked_from_ordinal_exclusive:6794}:{id};
    prefixClient.readTurns=async()=>{throw Error('已有 fork 证据不应再次比较正文');};
    const nativeFork=await second.sync(cachedProject,true);
    const child=nativeFork.nodes.find(n=>n.id==='b');
    assert.equal(child.relationSource,'codex-fork');assert.equal(child.parentKey,'codex:a');assert.equal(child.forkedFromOrdinalExclusive,6794);
    await second.close();
    console.log(JSON.stringify({ ok: true, checks: ['原生归属优先、Windows 目录恢复、默认工作区与双平台独立分组', '真实 DSH Session/v4 历史准入', '完整分页与8000字正文', '迁移保留源与原始快照', '原生DSH分支参数', '深度1/2/3', 'DeepSeek摘要关闭思考、增量正文与截断/空正文处理', '完整项目注册与副本同深度', '复制单任务及重复同步无重复', '复制完成轮询状态', '临时会话过滤与损坏隔离', '空白隐藏、缓存复用与新消息恢复', '目录请求即时返回缓存', '重启后前缀结果复用', '忙时暂停后台预载'] }));
  } finally { await service.close(); hook.deregister(); await fs.rm(fixtureRoot, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
