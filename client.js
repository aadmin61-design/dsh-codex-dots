// DSH 原生客户端模块；复用宿主 React，不需要安装或构建环境。
window.__ModuleLoader__.load({ id: '@local/dsh-codex-dots', factory: require => {
  const React = require('react');
  const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives');
  const { createElement: h, useState, useEffect, useRef, useSyncExternalStore } = React;
  const markdownLabels = { code: { copyLabel: '复制代码', copiedLabel: '已复制', toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消换行' } }, footnotes: '脚注' };
  // 历史采用完整轮次；按稳定 ID 去重，新的分页不能覆盖已经刷新过的轮次。
  function mergeTurns(newest, older = []) {
    const merged = new Map(newest.map(t => [t.id, t]));
    for (const turn of older) if (!merged.has(turn.id)) merged.set(turn.id, turn);
    return [...merged.values()];
  }
  function withLive(turns, live, active) {
    if (!live) return turns;
    const saved = turns.find(t => t.id === live.id);
    if (!saved && !active && Date.now() - live.updatedAt > 15000) return turns;
    const items = new Map((saved?.items || []).map(i => [i.id, i]));
    for (const item of live.items) {
      const old = items.get(item.id);
      // 已保存正文比增量长时保留正文，避免暂停/落盘交错导致文本回退。
      if (!old || item.liveComplete || (item.text || '').length >= (old.text || '').length) items.set(item.id, item);
    }
    const merged = { ...saved, ...live, items: [...items.values()] };
    return saved ? turns.map(t => t.id === live.id ? merged : t) : [merged, ...turns];
  }
  const ID = 'codex-dots', CATALOG = ID + '-catalog', MONITOR = ID + '-monitor';
  const labels = { running: '执行中', starting: '准备中', queued: '排队', 'awaiting-decision': '等待 DeepSeek 决策', paused: '已暂停', stopping: '正在收尾', completed: '已完成', cancelled: '已取消', ready: '待启动' };
  const css = `
.dots-shell{display:flex;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#242529);background:var(--dsw-alias-background-primary,#fff);font:14px/1.6 system-ui,sans-serif}
.dots-tree{width:260px;min-width:200px;border-right:1px solid #8882;background:var(--dsw-specific-sidebar-fill,#f8f8fa);display:flex;flex-direction:column;min-height:0}
.dots-tree.standalone{width:100%;border:0;height:100%}.dots-head{padding:16px 18px;border-bottom:1px solid #8882;display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dots-head strong{font-size:16px;flex:1;min-width:80px}.dots-search{display:flex;gap:6px;padding:12px}.dots-search input{min-width:0;width:100%}.dots-projects{overflow:auto;padding:4px 10px 20px;flex:1}.dots-project{margin:12px 0}.dots-project summary{cursor:pointer;padding:6px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dots-row{display:block;width:100%;border:0;background:transparent;color:inherit;text-align:left;border-radius:10px;padding:9px 12px 9px 30px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:inherit}.dots-row:hover,.dots-row.selected{background:#81858d18}.dots-row.selected{box-shadow:inset 3px 0 #527fff}.dots-muted{color:var(--dsw-alias-label-secondary,#777);font-size:12px}.dots-empty{padding:28px 20px;color:var(--dsw-alias-label-secondary,#777)}
.dots-view{display:flex;flex:1;min-width:0;min-height:0;height:100%;flex-direction:column}.dots-view button,.dots-tree button:not(.dots-row),.dots-header-button{border:1px solid #8883;background:transparent;color:inherit;border-radius:8px;padding:6px 10px;cursor:pointer;font:inherit}.dots-view button:disabled,.dots-tree button:disabled{opacity:.45;cursor:default}.dots-view input,.dots-view textarea,.dots-tree input{font:inherit;color:inherit;background:transparent;border:1px solid #8884;border-radius:8px;padding:7px 10px}.dots-body{overflow:auto;flex:1;padding:20px clamp(14px,4vw,52px);min-height:100px}.dots-message{margin:0 0 24px;white-space:pre-wrap;overflow-wrap:anywhere}.dots-message.user{margin-left:auto;max-width:86%;background:#6cafff18;padding:12px 16px;border-radius:18px}.dots-message.assistant{max-width:100%;padding:6px 0}.dots-message.tool{font-size:12px;background:#8881;padding:10px;border-radius:8px}.dots-label{font-size:12px;color:var(--dsw-alias-label-secondary,#777);margin-bottom:6px}.dots-status{padding:10px 18px;background:#799cff0c;border-bottom:1px solid #8882;display:flex;gap:12px;flex-wrap:wrap;font-size:12px}.dots-error{color:#c04c43;padding:12px 18px;white-space:pre-wrap}.dots-compose{padding:14px 18px;border-top:1px solid #8882}.dots-compose textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:64px}.dots-actions{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-top:8px}.dots-primary{background:#426bec!important;color:white!important;border-color:transparent!important}.dots-pin{background:transparent;border:0;cursor:pointer;color:inherit}.dots-title{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dots-badge{display:inline-block;border-radius:6px;background:#8881;padding:1px 6px}.dots-live{border-left:2px solid #527fff;padding-left:12px}.dots-more{margin:10px}.dots-mini{font-size:12px;padding:6px 12px}.dots-full{height:100%;min-height:0}@media(max-width:800px){.dots-tree:not(.standalone){width:210px;min-width:160px}.dots-body{padding:16px}}
`;
  // 窄侧栏中按钮不挤成竖排，保留搜索输入与动作的清晰关系。
  const extraCss = '.dots-search button{flex-shrink:0;white-space:nowrap}.dots-search input{flex:1}.dots-head button{flex-shrink:0;white-space:nowrap}.dots-markdown{white-space:normal;min-width:0}.dots-markdown pre{overflow-x:auto}.dots-markdown table{display:block;overflow-x:auto}.dots-message details summary{cursor:pointer}.dots-source{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 monospace}.dots-history-actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}';
  const api = async (endpoint, params = {}, body, signal) => {
    const transport = globalThis.__DSH_TRANSPORT__;
    const send = transport?.fetch ? transport.fetch.bind(transport) : globalThis.fetch.bind(globalThis);
    const query = new URLSearchParams(Object.entries(params).filter(([,v]) => v !== undefined && v !== null));
    const response = await send('/api/codex-dots/' + endpoint + '?' + query, {
      method: body ? 'POST' : 'GET', credentials: 'same-origin', signal,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '面板请求失败'); return result;
  };
  // 主页面使用宿主导航进入原生 DSH 对话；项目树和两端命令共享磁盘中的父子关系。
  function ProjectTree({ ctx }) {
    const [projects, setProjects] = useState([]), [project, setProject] = useState(''), [tree, setTree] = useState(null);
    const [key, setKey] = useState(''), [messages, setMessages] = useState([]), [error, setError] = useState('');
    const [busy, setBusy] = useState(false), [loadingHistory, setLoadingHistory] = useState(false), [form, setForm] = useState(null);
    const [title, setTitle] = useState(''), [intent, setIntent] = useState(''), [summarize, setSummarize] = useState(true);
    const [parentKey, setParentKey] = useState(''), [filter, setFilter] = useState(''), [cliPath, setCliPath] = useState('');
    const owner = () => ctx.uiSession.adapter.current.getSnapshot().key || '';
    const selected = tree?.nodes.find(n => n.key === key);
    const discover = async signal => { const r = await api('conversation-projects', {}, undefined, signal); setProjects(r.projects); setCliPath(r.cliPath); if (r.errors.length) setError(r.errors.join('\n')); };
    useEffect(() => { const cancel = new AbortController(); discover(cancel.signal).catch(e => { if (!cancel.signal.aborted) setError(e.message); }); return () => cancel.abort(); }, []);
    useEffect(() => {
      if (!project) return;
      const cancel = new AbortController(); let timer;
      setTree(null); setKey(''); setMessages([]); setForm(null); setError('');
      const poll = async () => {
        try { const data = await api('conversation-tree', { project, owner: owner() }, undefined, cancel.signal); if (!cancel.signal.aborted) setTree(data); }
        catch (e) { if (!cancel.signal.aborted) setError(e.message); }
        if (!cancel.signal.aborted) timer = setTimeout(poll, 4000);
      };
      api('conversation-sync', {}, { project, includeArchived: true }, cancel.signal).then(data => {
        if (!cancel.signal.aborted) { setTree(data); if (data.errors.length) setError(data.errors.join('\n')); void poll(); }
      }).catch(e => { if (!cancel.signal.aborted) { setError(e.message); void poll(); } });
      return () => { cancel.abort(); clearTimeout(timer); };
    }, [project]);
    useEffect(() => {
      if (!project || !key) return;
      const cancel = new AbortController(); let timer;
      setMessages([]); setLoadingHistory(true);
      const refresh = async () => {
        try { const result = await api('conversation-history', { project, key }, undefined, cancel.signal); if (!cancel.signal.aborted) { setMessages(result.messages); setLoadingHistory(false); } }
        catch (e) { if (!cancel.signal.aborted) { setError(e.message); setLoadingHistory(false); } }
        if (!cancel.signal.aborted) timer = setTimeout(refresh, 5000);
      };
      void refresh(); return () => { cancel.abort(); clearTimeout(timer); };
    }, [project, key]);
    const act = async action => { setBusy(true); setError(''); try { await action(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
    const open = id => { ctx.layout.selectPanel(null); ctx.uiWorkspace.openSession(id); };
    const startForm = kind => { setForm(kind); setTitle(kind === 'new' ? '新对话' : (selected?.title || '对话') + ' · 分支'); setIntent(kind === 'migrate' ? '将 Codex 历史迁移到 DSH，用 DeepSeek 继续' : ''); };
    const create = () => act(async () => {
      const result = await api('conversation-create', {}, { project, parentKey: form === 'new' ? undefined : key, title, intent, summarize, owner: owner() });
      setTree(result.tree); setKey(result.key); setForm(null);
      if (result.summaryError) setError('对话已创建，分支摘要待补充：' + result.summaryError);
      else open(result.sessionId);
    });
    const reason = node => node.reasonStatus === 'ready' ? node.reason : node.reasonStatus === 'error' ? '摘要失败，可重试' : node.parentKey ? '待 DeepSeek 总结' : '';
    const renderNode = node => {
      const children = tree.nodes.filter(n => n.parentKey === node.key);
      return h('li', { key: node.key },
        h('button', { className: 'dots-tree-node' + (node.key === key ? ' selected' : ''), onClick: () => { setKey(node.key); setParentKey(node.parentKey || ''); setIntent(node.intent || ''); setForm(null); }, onDoubleClick: () => node.source === 'dsh' && open(node.id), title: node.title },
          h('span', { className: 'dots-badge' }, node.source === 'dsh' ? 'DSH' : 'Codex'), ' ', node.title,
          h('small', null, `深度 ${node.depth ?? '?'}${node.archived ? ' · 已归档' : ''}`)),
        node.parentKey && h('div', { className: 'dots-branch-label', title: node.intent }, '↳ ', reason(node)),
        node.unresolved && h('div', { className: 'dots-branch-label' }, '来源待关联'),
        children.length > 0 && h('ul', null, ...children.map(renderNode)));
    };
    const roots = tree?.nodes.filter(n => !n.parentKey || !tree.nodes.some(p => p.key === n.parentKey)) || [];
    return h('div', { className: 'dots-project-page' },
      h('aside', { className: 'dots-projects' }, h('div', { className: 'dots-head' }, h('strong', null, '项目与对话树'), h('button', { disabled: busy, onClick: () => act(() => discover()) }, '刷新项目')),
        h('input', { placeholder: '搜索项目', value: filter, onChange: e => setFilter(e.target.value) }),
        ...projects.filter(p => (p.title + p.path).toLowerCase().includes(filter.toLowerCase())).map(p => h('button', { key: p.path, disabled: busy, className: 'dots-project-pick' + (project === p.path ? ' selected' : ''), onClick: () => setProject(p.path), title: p.path }, '📁 ', p.title, h('small', null, p.sources.join(' + ')))),
        project && h('div', { className: 'dots-project-branch' }, h('strong', { title: project }, '📁 根目录 · 深度 0'),
          tree ? h('ul', { className: 'dots-hierarchy' }, ...roots.map(renderNode)) : h('p', null, '正在同步两端对话…'))),
      h('main', { className: 'dots-project-detail' },
        h('div', { className: 'dots-head' }, h('div', null, h('strong', null, selected?.title || '项目对话树'), h('div', { className: 'dots-muted' }, project || '从左侧选择项目文件夹')),
          project && h('div', { className: 'dots-actions' },
            h('button', { disabled: busy, onClick: () => act(async () => { const r = await api('conversation-sync', {}, { project, includeArchived: true }); setTree(r); setError(r.errors.join('\n')); }) }, '同步两端'),
            h('button', { disabled: busy, onClick: () => startForm('new') }, '从 0 新开'),
            selected && h('button', { disabled: busy, onClick: () => startForm(selected.source === 'codex' ? 'migrate' : 'branch') }, selected.source === 'codex' ? '迁移到 DSH 继续' : '新建分支'),
            selected?.source === 'dsh' && h('button', { className: 'dots-primary', onClick: () => open(selected.id) }, '进入 DSH 对话'))),
        error && h('div', { className: 'dots-tree-error', role: 'alert' }, error),
        project && tree && h('div', { className: 'dots-tree-settings' },
          h('label', null, h('input', { type: 'checkbox', checked: tree.autoSummaries, disabled: busy, onChange: e => { const enabled = e.target.checked; void act(async () => setTree(await api('conversation-settings', {}, { project, autoSummaries: enabled }))); } }), ' 自动用 DeepSeek 总结新分支（消耗少量额度）'),
          h('details', null, h('summary', null, '与 Codex 共建此树'), h('p', null, '两端共用 ', h('code', null, project + '/.dsh-codex-dots/tree.json'), '。Codex 命令入口：', h('code', null, cliPath), '。使用 list / register / link，修改后本页面自动刷新。分支应填写真实来源 key 和 intent，DeepSeek 再总结原因。'), selected && h('p', null, '当前节点 key：', h('code', null, selected.key)))),
        form && h('section', { className: 'dots-tree-form' }, h('strong', null, form === 'new' ? '创建深度 1 的空白 DSH 对话' : `创建深度 ${selected?.depth == null ? '?' : selected.depth + 1} 的 DSH 分支`),
          h('input', { value: title, placeholder: '对话标题', onChange: e => setTitle(e.target.value) }),
          form !== 'new' && h('textarea', { value: intent, placeholder: '这次为什么分支，希望接下来做什么？', onChange: e => setIntent(e.target.value) }),
          form !== 'new' && h('label', null, h('input', { type: 'checkbox', checked: summarize, onChange: e => setSummarize(e.target.checked) }), ' 用 DeepSeek 总结分支原因（消耗少量额度）'),
          h('p', { className: 'dots-muted' }, '保留原对话；历史工具记录不会执行。创建后进入 DSH，由你发送下一条消息。'),
          h('button', { disabled: busy || !title.trim() || (form !== 'new' && !intent.trim()), className: 'dots-primary', onClick: create }, busy ? '处理中…' : '创建并进入 DSH'),
          h('button', { disabled: busy, onClick: () => setForm(null) }, '取消')),
        selected && !form && h('details', { className: 'dots-tree-relation' }, h('summary', null, `分支关系 · ${selected.depth == null ? '来源待关联' : '深度 ' + selected.depth} · ${reason(selected) || '从 0 新开'}`),
          h('select', { value: parentKey, onChange: e => setParentKey(e.target.value) }, h('option', { value: '' }, '项目根目录（从 0 新开）'), ...tree.nodes.filter(n => n.key !== key).map(n => h('option', { key: n.key, value: n.key }, `${n.source} · ${n.title}`))),
          h('textarea', { value: intent, placeholder: '真实分支原因', onChange: e => setIntent(e.target.value) }),
          h('button', { disabled: busy, onClick: () => act(async () => setTree(await api('conversation-link', {}, { project, key, parentKey, intent }))) }, '保存关系'),
          selected.parentKey && h('button', { disabled: busy, onClick: () => act(async () => setTree(await api('conversation-summary', {}, { project, key, owner: owner() }))) }, 'DeepSeek 总结（消耗额度）'),
          selected.reasonError && h('p', null, selected.reasonError)),
        h('div', { className: 'dots-tree-history' },
          !selected ? h('p', { className: 'dots-empty' }, '选择对话查看完整历史；双击 DSH 节点可直接进入聊天。') : loadingHistory ? h('p', null, '正在读取完整历史…') : messages.length ? messages.map((m, i) => h('article', { key: m.id + ':' + i, className: 'dots-message' }, h('small', { className: 'dots-muted' }, m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '历史工具记录'), h(MarkdownText, { text: m.text, streaming: false, labels: markdownLabels }))) : h('p', null, '此对话还没有消息'))));
  }
  function apply(ctx) {
    let snapshot = { owner: '', threadId: '', data: { runs: [] }, error: '', query: null };
    const listeners = new Set(), hints = new Map(), selection = new Map(), followed = new Map();
    const publish = patch => { snapshot = { ...snapshot, ...patch }; for (const f of listeners) f(); };
    const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
    const useView = () => useSyncExternalStore(subscribe, () => snapshot);
    const select = (id, open = false) => {
      selection.set(snapshot.owner, id); publish({ threadId: id });
      if (open && snapshot.owner) { ctx.layout.selectPanel(null); ctx.sidebarRight.openTab(MONITOR); }
    };
    const refreshState = async signal => {
      const owner = ctx.uiSession.adapter.current.getSnapshot().key ?? '';
      if (owner !== snapshot.owner) publish({ owner, threadId: selection.get(owner) ?? '', data: { runs: [] }, error: '', query: null });
      if (!owner) return;
      const data = await api('state', { owner }, undefined, signal);
      if (snapshot.owner !== owner) return;
      publish({ data, error: '' });
      // 新建线程异步返回 ID 后自动切到新代管对话；同一任务不反复抢走手动选择。
      const managed = [...data.runs].reverse().find(r => r.workers.some(w => w.threadId));
      if (managed && !['completed', 'cancelled'].includes(managed.status)) {
        const key = managed.id + ':' + managed.workers.find(w => w.threadId).threadId;
        if (followed.get(owner) !== key) { followed.set(owner, key); select(managed.workers.find(w => w.threadId).threadId, true); }
      }
      if (data.hint && hints.get(owner) !== data.hint.revision) {
        hints.set(owner, data.hint.revision);
        if (data.hint.kind === 'catalog') { publish({ query: data.hint }); ctx.sidebarRight.openTab(CATALOG); }
        else { select(data.hint.threadId); ctx.sidebarRight.openTab(MONITOR); }
      }
      if (!snapshot.threadId) {
        const current = [...data.runs].reverse().find(r => r.workers.some(w => w.threadId));
        if (current) select(current.workers.find(w => w.threadId).threadId);
      }
    };
    ctx.effect(() => {
      const style = document.createElement('style'); style.textContent = css + extraCss + treeCss; style.dataset.plugin = ID; document.head.append(style);
      let closed = false, timer; const abort = new AbortController();
      const loop = async () => {
        try { await refreshState(abort.signal); } catch (e) { if (!closed) publish({ error: e.message }); }
        if (!closed) timer = setTimeout(loop, 700);
      }; void loop();
      return () => { closed = true; abort.abort(); clearTimeout(timer); style.remove(); listeners.clear(); };
    });
    function Catalog({ standalone = false, open = false }) {
      const state = useView();
      const [rows, setRows] = useState([]), [cursor, setCursor] = useState(null), [search, setSearch] = useState('');
      const [busy, setBusy] = useState(false), [error, setError] = useState('');
      const filter = useRef({}), serial = useRef(0);
      const load = async (more = false) => {
        const ticket = ++serial.current; setBusy(true); setError('');
        try {
          const page = await api('threads', { ...filter.current, searchTerm: search || undefined, ...(more ? { cursor } : {}) });
          if (ticket !== serial.current) return;
          setRows(old => more ? [...new Map([...old, ...page.data].map(t => [t.id, t])).values()] : page.data); setCursor(page.nextCursor);
        } catch (e) { if (ticket === serial.current) setError(e.message); }
        finally { if (ticket === serial.current) setBusy(false); }
      };
      useEffect(() => { void load(); return () => { serial.current++; }; }, []);
      useEffect(() => {
        if (!state.query) return;
        serial.current++; filter.current = state.query.options ?? {}; setSearch(filter.current.searchTerm ?? '');
        setRows(state.query.result.data); setCursor(state.query.result.nextCursor); setBusy(false);
      }, [state.query]);
      const groups = new Map();
      for (const row of rows) { const cwd = row.cwd || '未关联项目'; if (!groups.has(cwd)) groups.set(cwd, []); groups.get(cwd).push(row); }
      const managed = new Set(state.data.runs.filter(r => !['completed','cancelled'].includes(r.status)).flatMap(r => r.workers.map(w => w.threadId)));
      return h('aside', { className: 'dots-tree' + (standalone ? ' standalone' : ''), 'aria-label': 'Codex 项目与对话' },
        h('div', { className: 'dots-head' }, h('strong', null, 'Codex 对话'), h('button', { onClick: () => load(), disabled: busy, title: '刷新对话列表' }, '刷新')),
        h('form', { className: 'dots-search', onSubmit: e => { e.preventDefault(); void load(); } }, h('input', { 'aria-label': '搜索 Codex 对话标题', placeholder: '搜索对话标题', value: search, onChange: e => setSearch(e.target.value) }), h('button', { disabled: busy }, '搜索')),
        filter.current.cwd && h('button', { className: 'dots-mini', onClick: () => { filter.current = {}; void load(); } }, '显示所有项目'),
        h('div', { className: 'dots-mini dots-muted' }, '项目 · ' + rows.length + ' 个已加载对话'),
        error && h('div', { className: 'dots-error', role: 'alert' }, error),
        h('div', { className: 'dots-projects' }, ...[...groups].map(([cwd, list]) => h('details', { className: 'dots-project', key: cwd, open: true },
          h('summary', { title: cwd }, '▱  ' + (cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd), h('span', { className: 'dots-muted' }, '  ' + list.length)),
          ...list.map(t => h('button', { key: t.id, className: 'dots-row' + (state.threadId === t.id ? ' selected' : ''), title: t.title + '\n' + t.cwd + '\n' + t.id,
            onClick: () => select(t.id, open), 'aria-current': state.threadId === t.id ? 'true' : undefined }, (managed.has(t.id) ? '● ' : '') + t.title)))),
          !rows.length && h('div', { className: 'dots-empty' }, busy ? '正在读取本机对话…' : '没有匹配的对话'),
          cursor && h('button', { className: 'dots-more', disabled: busy, onClick: () => load(true) }, busy ? '读取中…' : '展开显示更多')));
    }
    function Viewer() {
      const state = useView(), id = state.threadId;
      const [thread, setThread] = useState(null), [error, setError] = useState(''), [goal, setGoal] = useState(''), [sending, setSending] = useState(false);
      const [cursor, setCursor] = useState(null), [loadingOlder, setLoadingOlder] = useState(false);
      const body = useRef(null), stick = useRef(true), paged = useRef(false), pagination = useRef(null), epoch = useRef(0);
      const found = [...state.data.runs].reverse().find(r => r.workers.some(w => w.threadId === id));
      const worker = found?.workers.find(w => w.threadId === id), running = ['running','starting','stopping'].includes(worker?.status);
      useEffect(() => {
        // 只有切换对话才清空草稿；后台状态变化不能丢失用户正在输入的目标。
        epoch.current++; setThread(null); setCursor(null); setError(''); setGoal(''); stick.current = true; paged.current = false;
        return () => { epoch.current++; pagination.current?.abort(); };
      }, [id]);
      useEffect(() => {
        if (!id) return;
        const abort = new AbortController(); let timer;
        const load = async () => {
          try {
            const result = await api('thread', { threadId: id }, undefined, abort.signal);
            // 暂停、恢复、完成都刷新；保留此前加载的所有轮次和分页游标。
            if (!abort.signal.aborted) { setThread(old => ({ ...result, turns: mergeTurns(result.turns, old?.turns) })); if (!paged.current) setCursor(result.nextCursor); setError(''); }
          } catch (e) { if (!abort.signal.aborted) setError(e.message); }
          if (!abort.signal.aborted) timer = setTimeout(load, 5000);
        }; void load();
        return () => { abort.abort(); clearTimeout(timer); };
      }, [id, found?.id, found?.status, worker?.status, worker?.turnId]);
      useEffect(() => { if (stick.current && body.current) body.current.scrollTop = body.current.scrollHeight; }, [thread, worker?.liveTurn?.updatedAt]);
      const loadOlder = async (all = false) => {
        const ticket = epoch.current, abort = new AbortController(); pagination.current = abort; setLoadingOlder(true);
        stick.current = false;
        let next = cursor; const seen = new Set();
        try {
          do {
            if (!next || seen.has(next)) break;
            seen.add(next);
            const result = await api('thread', { threadId: id, cursor: next }, undefined, abort.signal);
            if (ticket !== epoch.current || abort.signal.aborted) break;
            paged.current = true; setThread(old => ({ ...old, turns: mergeTurns(old?.turns || [], result.turns) }));
            next = result.nextCursor; setCursor(next);
          } while (all && next);
        } catch (e) { if (!abort.signal.aborted && ticket === epoch.current) setError(e.message); }
        finally { if (ticket === epoch.current) setLoadingOlder(false); }
      };
      const submit = async () => {
        setSending(true); setError('');
        try { await api('continue', {}, { owner: state.owner, threadId: id, goal }); setGoal(''); ctx.layout.selectPanel(null); ctx.sidebarRight.openTab(MONITOR); }
        catch (e) { setError(e.message); } finally { setSending(false); }
      };
      if (!id) return h('section', { className: 'dots-view' }, h('div', { className: 'dots-empty' }, '从左侧选择 Codex 对话，查看历史或交给 DeepSeek 继续。'));
      const turns = withLive(thread?.turns || [], worker?.liveTurn, running).slice().reverse();
      const message = (turn, item, n) => {
        const assistant = item.type === 'agentMessage', user = item.type === 'userMessage';
        const streaming = running && turn.id === worker?.liveTurn?.id && !item.liveComplete;
        const label = user ? '用户 / DeepSeek 指令' : assistant ? 'Codex' + (streaming ? ' · 实时输出' : '') : item.type;
        const content = h('div', { className: 'dots-markdown' }, h(MarkdownText, { text: item.text || '', streaming, labels: markdownLabels }));
        return h('article', { key: turn.id + ':' + (item.id || n), className: 'dots-message ' + (user ? 'user' : assistant ? 'assistant' : 'tool'), 'data-message-id': item.id },
          h('div', { className: 'dots-label' }, label),
          user || assistant || item.type === 'plan' ? content : h('details', null, h('summary', null, '展开完整内容'), h('pre', { className: 'dots-source' }, item.text)),
          h('details', { className: 'dots-muted' }, h('summary', null, '原文 / 完整记录'), h('pre', { className: 'dots-source' }, user || assistant ? item.text : JSON.stringify(item, null, 2))));
      };
      return h('section', { className: 'dots-view', 'aria-label': 'Codex 对话内容' },
        h('header', { className: 'dots-head' }, h('strong', { className: 'dots-title', title: thread?.title }, thread?.title || '正在读取对话…'),
          h('button', { onClick: () => { ctx.layout.selectPanel(null); ctx.sidebarRight.openTab(CATALOG); } }, '选择对话')),
        h('div', { className: 'dots-mini dots-muted', title: id }, thread?.cwd || id),
        found && h('div', { className: 'dots-status' }, h('span', { className: 'dots-badge' }, labels[found.status] || found.status),
          h('span', null, labels[worker.status] || worker.status), h('span', null, `${found.turns}/${found.maxTurns} 轮`),
          h('span', null, worker.model || '默认模型'), h('span', null, worker.sandbox),
          h('span', null, `停止阈值 ${found.quota.stopAtLeftPercent ?? '未设置'}%`), found.reason && h('span', null, found.reason)),
        (error || state.error) && h('div', { className: 'dots-error', role: 'alert' }, error || state.error),
        h('div', { className: 'dots-body', ref: body, onScroll: e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; } },
          cursor && h('div', { className: 'dots-history-actions' }, h('button', { disabled: loadingOlder, onClick: () => loadOlder() }, '加载更早消息'), h('button', { disabled: loadingOlder, onClick: () => loadOlder(true) }, '加载全部历史'), loadingOlder && h('button', { onClick: () => pagination.current?.abort() }, '停止加载')),
          ...turns.flatMap(turn => turn.items.map((item, n) => message(turn, item, n))),
          running && !worker?.liveTurn?.items.some(i => i.type === 'agentMessage') && h('div', { className: 'dots-muted' }, 'Codex 正在执行，等待正文输出…'),
          thread && !turns.length && h('div', { className: 'dots-empty' }, '这个对话还没有消息'),
          h('div', { className: 'dots-muted' }, `已加载 ${turns.length} 轮${cursor ? '，还有更早历史' : '，已到历史起点'}。正文不截断；浏览不启动 Codex 模型。`)),
        h('div', { className: 'dots-compose' }, h('textarea', { 'aria-label': '交给 DeepSeek 的继续目标', placeholder: '希望这个对话接下来完成什么？', value: goal, onChange: e => setGoal(e.target.value), maxLength: 6000 }),
          h('div', { className: 'dots-actions' }, h('span', { className: 'dots-muted' }, state.owner ? 'DeepSeek 制定计划，确认后才执行 Codex' : '先打开一个 DSH 主对话'),
            h('button', { className: 'dots-primary', disabled: sending || !goal.trim() || !state.owner, onClick: submit }, sending ? '正在提交…' : '交给 DeepSeek 继续'))));
    }
    const bind = (slot, options, Component) => ctx.effect(() => ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, ...options }, Component)));
    bind('sidebar.panellist', { id: ID + '-tree', label: '项目对话树', order: 19 }, () => h('span', null, '⑂'));
    bind('main', { key: ID + '-tree' }, () => h(ProjectTree, { ctx }));
    bind('sidebar.panellist', { id: ID, label: 'Codex 对话', order: 20 }, () => h('span', null, '◫'));
    bind('main', { key: ID }, () => h('div', { className: 'dots-shell' }, h(Catalog), h(Viewer)));
    bind('conversation.session.header.utilities', { id: ID, order: 20 }, () => h('button', { className: 'dots-header-button', title: '浏览 Codex 对话', onClick: () => ctx.sidebarRight.openTab(CATALOG) }, 'Codex'));
    for (const [kind, title, Component] of [[CATALOG, 'Codex 对话列表', () => h(Catalog, { standalone: true, open: true })], [MONITOR, '代管 Codex 对话', Viewer]]) {
      ctx.effect(() => ctx.sidebarRightTabs.register({ id: kind, kind, title: () => title, priority: 'extension' }));
      bind('sidebar.right.pane.tab', { key: kind }, () => h('div', { className: 'dots-shell dots-full' }, h(Component)));
      bind('sidebar.right.pane.tab.title', { key: kind }, () => h('span', null, title));
    }
  }
  const treeCss = '.dots-project-page{display:flex;height:100%;min-height:0;color:inherit;background:var(--background,transparent)}.dots-projects{width:320px;min-width:230px;overflow:auto;border-right:1px solid #8883;padding:12px}.dots-project-pick{display:block;width:100%;text-align:left;padding:10px;border:0;background:transparent;color:inherit;border-radius:8px;cursor:pointer}.dots-project-pick small,.dots-tree-node small{display:block;opacity:.55;font-size:11px;margin-top:3px}.dots-project-pick.selected,.dots-tree-node.selected{background:#527fff20}.dots-project-branch{margin-top:24px}.dots-hierarchy,.dots-hierarchy ul{list-style:none;padding-left:15px}.dots-hierarchy ul{border-left:1px solid #8885;margin-left:8px}.dots-tree-node{display:block;width:100%;border:0;background:transparent;color:inherit;text-align:left;padding:8px;border-radius:7px;cursor:pointer;overflow-wrap:anywhere}.dots-branch-label{font-size:11px;opacity:.7;padding:0 8px 8px 20px}.dots-project-detail{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden}.dots-project-detail>.dots-head{flex-wrap:wrap;gap:12px}.dots-project-page button,.dots-project-page input,.dots-project-page textarea,.dots-project-page select{font:inherit}.dots-projects>input{box-sizing:border-box;width:100%;padding:7px}.dots-tree-settings,.dots-tree-form,.dots-tree-relation{padding:12px 20px;border-bottom:1px solid #8882;font-size:13px}.dots-tree-settings details{margin-top:8px}.dots-tree-form>input,.dots-tree-form>textarea,.dots-tree-relation>textarea,.dots-tree-relation>select{box-sizing:border-box;display:block;width:100%;padding:8px;margin:8px 0}.dots-tree-form button,.dots-tree-relation button{margin:6px 8px 0 0;padding:6px 12px;cursor:pointer}.dots-tree-error{white-space:pre-wrap;background:#c5535312;color:#bf5252;padding:10px 20px}.dots-tree-history{flex:1;overflow:auto;padding:20px 28px}.dots-tree-history .dots-message{max-width:960px;margin:0 auto 24px}.dots-tree-history pre{overflow:auto}.dots-tree-history table{display:block;overflow:auto}@media(max-width:850px){.dots-projects{width:230px;min-width:180px}.dots-tree-history{padding:14px}}';
  return { apply, mergeTurns, withLive, inject: ['slots', 'layout', 'uiSession', 'uiWorkspace', 'sidebarRight', 'sidebarRightTabs'] };
} });
