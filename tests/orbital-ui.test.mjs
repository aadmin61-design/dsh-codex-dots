import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 仅离线组件渲染，不连接或操作 DSH 界面。
function fixture(seed = [], respond = async () => ({})) {
  const state = seed.slice(), slots = [], preferences={reducedMotion:false}; let cursor = 0, plugin;
  const react = { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null && x !== false) }),
    useState: initial => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value; }]; },
    useEffect() {}, useLayoutEffect() {}, useMemo:fn=>fn(), useSyncExternalStore: (_subscribe, read) => read(), useRef: value => ({ current: value }) };
  vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: def => { plugin = def.factory(name => name === 'react' ? react : { MarkdownText: 'markdown' }); } } },
    getComputedStyle:el=>({fontSize:'14px',padding:'0px',display:'block',opacity:String(el.opacity??1)}),matchMedia:()=>({matches:preferences.reducedMotion}),
    URLSearchParams, setTimeout, clearTimeout, fetch: async (url, options) => { const value=await respond(url,options);return value instanceof Response?value:Response.json(value); },
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} } }, console });
  const opened = [], panels = [], ctx = { effect: fn => fn(), slots: { inject: (_name, fn) => fn(), register: (options, Component) => { slots.push({ options, Component }); return () => {}; } },
    layout: { selectPanel(id) { panels.push(id); } }, uiWorkspace: { openSession: id => opened.push(id) }, uiSession: { adapter: { current: { getSnapshot: () => ({ key: 'owner' }) } } } };
  plugin.apply(ctx);
  const root = slots.find(s => s.options.name === 'main').Component();
  return { plugin, state, opened, panels, preferences, render: () => { cursor = 0; return root.type(root.props); } };
}
function flatten(node) { return typeof node !== 'object' || node === null ? [] : [node, ...node.children.flatMap(flatten)]; }

// 用离线几何与可控 WAAPI 替身验证跨容器和动画中断，不启动或控制 DSH 界面。
function motionFixture() {
  const {plugin,preferences}=fixture(), metrics={clones:0}, layer={children:[],append(el){el.parent=this;this.children.push(el);}};
  const element=(key,left=300,top=200,size=120)=>({
    dataset:{motionKey:key,motionSide:'codex'},style:{},rect:{left,top,width:size,height:size},animations:[],
    getBoundingClientRect(){return this.rect;},querySelectorAll(){return [];},querySelector(){return null;},
    cloneNode(){metrics.clones++;return element(this.dataset.motionKey,this.rect.left,this.rect.top,this.rect.width);},
    removeAttribute(){delete this.dataset.motionKey;},setAttribute(){},
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);},
    animate(frames,options){let finish,reject;const finished=new Promise((yes,no)=>{finish=yes;reject=no;});const animation={frames,options,finished,finish,cancel(){reject(Error('cancelled'));}};this.animations.push(animation);return animation;},
  });
  const root={nodes:[],classList:{add(){},remove(){}},querySelectorAll(){return this.nodes;},getBoundingClientRect(){return {left:0,top:0,width:1000,height:700};}};
  return {root,layer,element,preferences,metrics,motion:plugin.createOrbitalMotion(root,layer)};
}
test('同一项目跨主页与侧栏使用当前位置过渡，动画完成清理代理', async () => {
  const f=motionFixture(), old=f.element('project:a');f.root.nodes=[old];f.motion.play();
  old.animations[0].finish();await Promise.resolve();
  f.motion.capture();const next=f.element('project:a',12,32,70);f.root.nodes=[next];f.motion.play();
  assert.equal(f.layer.children.length,1);
  const ghost=f.layer.children[0];assert.equal(ghost.style.left,'300px');assert.equal(ghost.style.top,'200px');
  assert.match(ghost.animations[0].frames.at(-1).transform,/translate\(-288px,-168px\)/);
  assert.equal(next.animations[0].frames[0].opacity,0);
  ghost.animations[0].finish();await Promise.resolve();await Promise.resolve();
  assert.equal(f.layer.children.length,0);f.motion.dispose();
});
test('筛选退场中重新匹配，从当前代理位置接续而非重新闪现', async () => {
  const f=motionFixture(), old=f.element('project:a');f.root.nodes=[old];f.motion.play();old.animations[0].finish();await Promise.resolve();
  f.motion.capture();f.root.nodes=[];f.motion.play();
  const exiting=f.layer.children[0];assert.match(exiting.animations[0].frames.at(-1).transform,/translate\(-460px,24px\)/);
  exiting.rect={left:180,top:210,width:100,height:100};exiting.opacity=.65;
  f.motion.capture();f.root.nodes=[f.element('project:a',440,160,120)];f.motion.play();
  assert.equal(f.layer.children.length,1);assert.equal(f.layer.children[0].style.left,'180px');
  assert.equal(f.layer.children[0].animations[0].frames[0].opacity,.65);
  f.motion.dispose();assert.equal(f.layer.children.length,0);
});
test('减少动态效果设置跳过移动和代理，卸载时取消仍在运行的动画', () => {
  const f=motionFixture();f.preferences.reducedMotion=true;const node=f.element('project:a');f.root.nodes=[node];f.motion.play();
  assert.equal(node.animations.length,0);assert.equal(f.layer.children.length,0);
  f.preferences.reducedMotion=false;f.motion.capture();f.root.nodes=[];f.motion.play();assert.equal(f.layer.children.length,1);
  f.motion.dispose();assert.equal(f.layer.children.length,0);
});
test('快照不克隆节点，未变化和屏幕外球不创建动画代理', () => {
  const f=motionFixture();f.preferences.reducedMotion=true;
  const nodes=Array.from({length:200},(_,i)=>f.element('project:'+i,300,i===0?200:900+i*150));
  f.root.nodes=nodes;f.motion.play();f.preferences.reducedMotion=false;
  f.motion.capture();assert.equal(f.metrics.clones,0);f.motion.play();
  assert.equal(f.metrics.clones,0);
  // 二百个球同时改变位置，只有可见的一个需要代理，其他球直接更新终点。
  f.motion.capture();f.root.nodes=nodes.map(n=>f.element(n.dataset.motionKey,n.rect.left+40,n.rect.top));f.motion.play();
  assert.equal(f.metrics.clones,1);assert.equal(f.layer.children.length,1);
  assert.equal(f.root.nodes.filter(n=>n.animations.length).length,1);
  f.motion.dispose();
});

test('提醒出现或消失不改变画布节点身份及项目球位置', async () => {
  const projects=Array.from({length:8},(_,i)=>({path:'/p'+i,title:'项目'+i,count:i,sources:['dsh']}));
  const page=fixture([projects]);
  const before=flatten(page.render());
  const positions=nodes=>nodes.filter(n=>n.props.className==='dots-project-orbit').map(n=>[n.props.style.left,n.props.style.top]);
  const original=positions(before);
  // 按已有 error 状态注入提示，模拟请求失败和后续清除。
  page.state[7]='测试提醒';
  const after=flatten(page.render());
  const workspace=after.find(n=>n.props.className==='dots-workspace');
  assert.equal(workspace.props.key,'workspace');
  assert.ok(flatten(workspace).some(n=>n.props.className==='dots-notices'&&flatten(n).some(x=>x.props.role==='alert')));
  assert.equal(after.find(n=>n.props.className==='dots-space').props.key,'canvas');
  assert.deepEqual(positions(after),original);
  page.state[7]='';assert.deepEqual(positions(flatten(page.render())),original);
});
test('分支创建成功后关闭窗口，不请求或展示历史，不自动跳转对话', async () => {
  for(const summaryError of [undefined,'模拟摘要失败']){
    const tree={nodes:[{key:'dsh:a',id:'a',source:'dsh',title:'父对话'}]},calls=[];
    const page=fixture([[{path:'/p',title:'项目',sources:['dsh']}],'/p',tree],async(url,options)=>{
      calls.push([url,JSON.parse(options.body)]);
      return {key:'dsh:b',sessionId:'b',tree:{nodes:[...tree.nodes,{key:'dsh:b',id:'b',source:'dsh',title:'分支',parentKey:'dsh:a'}]},summaryError};
    });
    flatten(page.render()).find(n=>n.props.title==='分支').props.onClick();
    const checkbox=flatten(page.render()).find(n=>n.type==='label'&&n.children.includes(' 使用 DeepSeek 总结原因（消耗模型额度）'));
    flatten(checkbox).find(n=>n.type==='input').props.onChange({target:{checked:true}});
    await flatten(page.render()).find(n=>n.children.includes('创建分支')).props.onClick();
    assert.equal(calls.length,1);assert.equal(calls[0][1].summarize,true);
    assert.equal(page.opened.length,0);
    assert.equal(flatten(page.render()).some(n=>n.type==='markdown'),false);
    await new Promise(resolve=>setTimeout(resolve,280));
    assert.equal(flatten(page.render()).some(n=>n.props.role==='dialog'),false);
    if(summaryError)assert.ok(flatten(page.render()).some(n=>n.children.includes('分支已创建，摘要未完成：'+summaryError)));
  }
});

test('纯文本 404 和旧后端能力缺失给出重启提示，不进入删除确认', async () => {
  for(const missingRoute of [true,false]){
    const calls=[],page=fixture([[{path:'/p',title:'项目',sources:['dsh']}],'/p',{nodes:[{key:'dsh:a',id:'a',source:'dsh',title:'a'}]}],async url=>{
      calls.push(url);
      if(url.includes('conversation-projects'))return {projects:[],capabilities:missingRoute?['permanent-delete-v1']:[]};
      return new Response('not found',{status:404});
    });
    await flatten(page.render()).find(n=>n.props.title==='删除').props.onClick();
    const error=flatten(page.render()).find(n=>n.props.role==='alert');
    assert.ok(error.children.join('').includes('完全退出'));
    assert.equal(error.children.join('').includes('Unexpected token'),false);
    assert.equal(calls.length,missingRoute?2:1);
    assert.equal(flatten(page.render()).some(n=>n.children.includes('再次确认，永久删除')),false);
  }
});

test('返回按钮依次关闭窗口、返回项目列表及原生 DSH 主视图', async () => {
  const page=fixture([[{path:'/p',title:'项目',sources:['dsh']}],'/p',{nodes:[]}]);
  flatten(page.render()).find(n=>n.props.title==='复制项目到 DSH').props.onClick();
  flatten(page.render()).find(n=>n.children.includes('← 返回项目')).props.onClick();
  await new Promise(resolve=>setTimeout(resolve,280));
  assert.equal(flatten(page.render()).some(n=>n.props.role==='dialog'),false);assert.equal(page.state[1],'/p');
  flatten(page.render()).find(n=>n.children.includes('← 返回')).props.onClick();assert.equal(page.state[1],'');
  flatten(page.render()).find(n=>n.children.includes('← 返回')).props.onClick();assert.deepEqual(page.panels,[null]);
});
test('空白和损坏会话默认不计入星图，诊断开关可查看而不会复活失效节点', () => {
  const nodes=[{key:'dsh:a',id:'a',source:'dsh',title:'有效对话'},
    {key:'dsh:b',id:'b',source:'dsh',title:'空白',empty:true},
    {key:'dsh:c',id:'c',source:'dsh',title:'损坏',unavailable:'stored log is corrupt'},
    {key:'dsh:d',id:'d',source:'dsh',hiddenReason:'missing'}];
  const page=fixture([[{path:'/p',title:'项目',sources:['dsh']}],'/p',{nodes}]);
  let elements=flatten(page.render());
  assert.equal(elements.filter(n=>n.props['aria-label']?.startsWith('进入 ')).length,1);
  assert.ok(elements.some(n=>n.children.includes('项目 · 1 个对话')));
  const label=elements.find(n=>n.type==='label'&&n.children.includes(' 显示空白/异常'));
  flatten(label).find(n=>n.type==='input').props.onChange({target:{checked:true}});
  elements=flatten(page.render());
  assert.equal(elements.filter(n=>n.props['aria-label']?.startsWith('进入 ')).length,3);
  elements.find(n=>n.props['aria-label']==='进入 损坏').props.onDoubleClick();
  assert.equal(page.opened.length,0);
  assert.ok(flatten(page.render()).some(n=>n.children.includes('该历史不可用：stored log is corrupt')));
});
test('DSH 原生会话单击只提示、双击进入且无需复制项目，复制操作只在根球悬浮菜单', () => {
  const tree = { nodes: [{key:'dsh:native',id:'native',source:'dsh',title:'原生',depth:1}, {key:'codex:cx',id:'cx',source:'codex',title:'未迁移',depth:1}] };
  const page = fixture([[{path:'/p',title:'项目',sources:['codex','dsh']}],'/p',tree]);
  const elements = flatten(page.render());
  elements.find(n=>n.props['aria-label']==='进入 原生').props.onClick();
  assert.deepEqual(page.opened,[]);
  assert.ok(flatten(page.render()).some(n=>n.children.includes('再次点击进入对话')));
  elements.find(n=>n.props['aria-label']==='进入 原生').props.onDoubleClick();
  assert.deepEqual(page.opened,['native']);
  assert.equal(flatten(page.render()).some(n=>n.children.includes('再次点击进入对话')),false);
  assert.equal(elements.some(n=>n.type==='header'&&flatten(n).some(c=>c.children.includes('复制项目到 DSH'))),false);
  const copy = elements.find(n=>n.props.title==='复制项目到 DSH');
  assert.equal(copy.props.className,'dots-satellite'); copy.props.onClick();
  const opened = flatten(page.render());
  assert.ok(opened.some(n=>n.props.role==='dialog'&&n.props['aria-modal']===true));
  assert.ok(opened.some(n=>n.props.className==='dots-modal-layer'));
  assert.ok(opened.some(n=>n.children.includes('确认复制整个项目到 DSH')));
});

test('删除界面先展示范围，两次确认分别发送请求，未确认不会执行删除', async () => {
  const calls = [], tree = {nodes:[{key:'dsh:a',id:'a',source:'dsh',title:'待删除',depth:1}]};
  const page = fixture([[{path:'/p',title:'项目',sources:['dsh']}],'/p',tree], async (url,options)=>{
    if(url.includes('conversation-projects'))return {projects:[],pluginVersion:'2.6.5',capabilities:['permanent-delete-v1']};
    calls.push([url,JSON.parse(options.body)]);
    return url.includes('delete-plan')?{token:'t',title:'待删除',scope:'conversation',codexCount:0,dshCount:1}:{confirmed:true};
  });
  await flatten(page.render()).find(n=>n.props.title==='删除').props.onClick();
  assert.equal(calls.length,1);
  let elements=flatten(page.render());
  assert.ok(elements.some(n=>n.children.includes('第一次确认：删除范围')));
  await elements.find(n=>n.children.includes('确认范围，继续')).props.onClick();
  assert.equal(calls.length,2); assert.equal(calls[1][1].step,1);
  elements=flatten(page.render());
  assert.ok(elements.some(n=>n.children.includes('第二次确认：永久删除历史')));
  assert.ok(elements.some(n=>n.children.includes('再次确认，永久删除')));
});
test('项目随机散布无重叠，数量控制有限球径，平台决定左右分组', () => {
  const { plugin } = fixture();
  const projects = Array.from({ length: 30 }, (_, i) => ({ path: '/p' + i, count: i * 7, sources: [i % 2 ? 'dsh' : 'codex'] }));
  const result = plugin.scatterProjects(projects, 1000, 700);
  assert.equal(result.projects.length, 30);
  assert.ok(plugin.projectSize(5) < plugin.projectSize(50));
  assert.equal(plugin.projectSize(100000), 156);
  for (const p of result.projects) {
    assert.ok(p.x - p.size / 2 >= 0 && p.x + p.size / 2 <= 1000);
    for (const q of result.projects) if (p.path !== q.path) assert.ok(Math.hypot(p.x-q.x,p.y-q.y) > (p.size+q.size)/2);
  }
  assert.equal(plugin.projectSide({ sources: ['codex','dsh'] }), 'codex');
  assert.equal(plugin.projectSide({ sources: ['dsh'] }), 'dsh');
});
test('默认不渲染后台子代理、临时与已消失节点，开关只恢复后台节点', () => {
  const tree = { nodes: [
    { key:'dsh:a',id:'a',source:'dsh',title:'普通',depth:1 },
    { key:'dsh:b',id:'b',source:'dsh',title:'子代理',depth:2,parentKey:'dsh:a',internal:true },
    { key:'dsh:c',id:'selectionchat-temp-c',source:'dsh',title:'临时' },
    { key:'dsh:d',id:'d',source:'dsh',title:'已删除',hiddenReason:'missing' },
  ] };
  const page = fixture([[{ path:'/p',title:'项目',sources:['dsh'] }],'/p',tree]);
  let elements=flatten(page.render());
  assert.equal(elements.filter(n=>n.props['aria-label']?.startsWith('进入 ')).length,1);
  flatten(elements.find(n=>n.type==='label'&&n.children.includes(' 显示后台子代理'))).find(n=>n.type==='input').props.onChange({target:{checked:true}});
  elements=flatten(page.render());
  assert.equal(elements.filter(n=>n.props['aria-label']?.startsWith('进入 ')).length,2);
});
test('分层布局合并迁移副本，子分支连接真实来源，兄弟节点不重叠', () => {
  const { plugin } = fixture();
  const result = plugin.layoutTree([{ key: 'c:a', depth: 1 }, { key: 'd:copy', mirrorOf: 'c:a', depth: 1 }, { key: 'd:b', parentKey: 'd:copy', depth: 2 }, { key: 'd:c', parentKey: 'c:a', depth: 2 }, { key: 'd:d', parentKey: 'd:b', depth: 3 }]);
  assert.equal(result.nodes.length, 4);
  const nodes = Object.fromEntries(result.nodes.map(n => [n.key, n]));
  assert.equal(nodes['d:b'].parentKey, 'c:a');
  assert.equal(nodes['d:b'].y, nodes['d:c'].y);
  assert.ok(nodes['d:b'].x !== nodes['d:c'].x);
  assert.ok(nodes['d:d'].y > nodes['d:b'].y);
});

test('少量节点和单链以根球为中轴，不再贴左侧', () => {
  const {plugin}=fixture();
  const model=plugin.layoutTree([{key:'a'},{key:'b',parentKey:'a'},{key:'c',parentKey:'b'}]);
  assert.equal(model.root.x,model.width/2);
  for(const n of model.nodes)assert.equal(n.x,model.root.x);
  assert.equal(plugin.treeScrollLeft(model,1200),0);
});

test('非对称子树紧凑排列，父球对齐直接孩子中点，各层球保持间距', () => {
  const {plugin}=fixture();
  const nodes=[{key:'a'},{key:'b',parentKey:'a'},{key:'c',parentKey:'a'},{key:'d',parentKey:'c'}];
  for(let i=0;i<7;i++)nodes.push({key:'leaf'+i,parentKey:'d'});
  const model=plugin.layoutTree(nodes),byKey=new Map(model.nodes.map(n=>[n.key,n]));
  assert.equal(byKey.get('b').x+220,byKey.get('c').x);
  assert.equal(byKey.get('a').x,model.root.x);
  for(const p of model.nodes){
    const children=model.nodes.filter(n=>n.parentKey===p.key).sort((a,b)=>a.x-b.x);
    if(children.length)assert.equal(p.x,(children[0].x+children.at(-1).x)/2);
    for(const q of model.nodes)if(p.key!==q.key&&p.y===q.y)assert.ok(Math.abs(p.x-q.x)>=220);
    assert.ok(p.x>=170&&model.width-p.x>=170);
  }
  assert.equal(model.root.x-plugin.treeScrollLeft(model,900),450);
});
test('项目球、树操作与整项目复制前置条件可渲染，全文 Markdown 不截断', () => {
  const projects = [{ path: '/project', title: '演示项目', sources: ['codex'] }];
  const tree = { nodes: [{ key: 'codex:a', id: 'a', title: '演示对话', source: 'codex', depth: 1 }] };
  const page = fixture([projects, '/project', tree]);
  let elements = flatten(page.render());
  const enter = elements.find(n => n.props['aria-label'] === '进入 演示对话');
  enter.props.onClick();
  assert.equal(flatten(page.render()).some(n=>n.props.role==='dialog'),false);
  enter.props.onDoubleClick();
  elements = flatten(page.render());
  assert.equal(page.opened.length, 0);
  assert.ok(elements.some(n => n.children.includes('确认复制整个项目到 DSH')));
  elements.find(n => n.type === 'button' && n.children.includes('历史') && n.props.className.includes('dots-chip')).props.onClick();
  const full = '开头' + '正文'.repeat(4000) + '结尾';
  page.state[9] = [{ id: 'm', role: 'assistant', text: full }];
  elements = flatten(page.render());
  assert.equal(elements.find(n => n.type === 'markdown').props.text, full);
  tree.lastCopyAt = 1; tree.nodes[0].dshSessionId = 'native-session';
  flatten(page.render()).find(n => n.props['aria-label'] === '进入 演示对话').props.onDoubleClick();
  assert.deepEqual(page.opened, ['native-session']);
});


test('独立对话散布、最近使用居中，默认隐藏归档和异常，逐条提供删除', () => {
  const group='standalone-conversations:dsh';
  const nodes=[
    {key:'dsh:old',id:'old',source:'dsh',title:'旧对话',recentAt:1},
    {key:'dsh:recent',id:'recent',source:'dsh',title:'最近对话',recentAt:9},
    {key:'dsh:archived',id:'archived',source:'dsh',title:'归档对话',archived:true},
    {key:'dsh:empty',id:'empty',source:'dsh',title:'草稿',empty:true},
    {key:'dsh:broken',id:'broken',source:'dsh',title:'损坏日志',unavailable:'corrupt'},
  ];
  const page=fixture([[{path:group,title:'DSH 独立对话',sources:['dsh'],standalone:true}],group,{nodes}]);
  let elements=flatten(page.render());
  assert.ok(elements.some(n=>n.props.className==='dots-galaxy dots-loose'));
  assert.ok(!elements.some(n=>n.type==='svg'));
  assert.equal(elements.filter(n=>n.props.title==='删除').length,2);
  const ball=elements.find(n=>n.props['data-motion-key']?.endsWith('dsh:recent'));
  assert.equal(ball.props.style.left+ball.props.style.width/2,450);
  assert.equal(ball.props.style.top+ball.props.style.height/2,325);
  const checkbox=flatten(elements.find(n=>n.type==='label'&&n.children.includes(' 显示已归档对话'))).find(n=>n.type==='input');
  assert.equal(checkbox.props.checked,false);
  checkbox.props.onChange({target:{checked:true}});
  elements=flatten(page.render());
  assert.equal(elements.filter(n=>n.props.title==='删除').length,3);
  assert.ok(elements.some(n=>n.props['aria-label']==='进入 归档对话'));
});
