// DSH 原生客户端模块；复用宿主 React，不需要安装或构建环境。
window.__ModuleLoader__.load({ id: '@local/dsh-codex-dots', factory: require => {
  const React = require('react');
  const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives');
  const { createElement: h, useState, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } = React;
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
  const ID = 'codex-dots-tree';
  const STANDALONE = 'standalone-conversations';
  const labels = { running: '执行中', starting: '准备中', queued: '排队', 'awaiting-decision': '等待决策', paused: '已暂停', stopping: '收尾中', completed: '已完成', cancelled: '已取消', ready: '待启动' };
  const api = async (endpoint, params = {}, body, signal) => {
    const transport = globalThis.__DSH_TRANSPORT__;
    const send = transport?.fetch ? transport.fetch.bind(transport) : globalThis.fetch.bind(globalThis);
    const query = new URLSearchParams(Object.entries(params).filter(([,v]) => v != null));
    const response = await send('/api/codex-dots/' + endpoint + '?' + query, { method: body ? 'POST' : 'GET', credentials: 'same-origin', signal,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    // 宿主未注册路由时返回纯文本 not found，不能无条件作为 JSON 解析。
    const raw = await response.text(); let result;
    try { result = JSON.parse(raw); } catch {
      if (response.status===404) throw Error('DSH 尚未加载此接口（'+endpoint+'）。请完全退出 DSH 后重开，确认前后端均为 2.6.11。');
      throw Error('接口 '+endpoint+' 返回异常（HTTP '+response.status+'）：'+raw.slice(0,240));
    }
    if (!response.ok) throw Error(result.error || '请求失败（HTTP '+response.status+'）'); return result;
  };
  // 副本是同一逻辑节点；新分支从副本出发时连接回来源球，保持真实层次。
  function layoutTree(nodes) {
    const all = new Map(nodes.map(n => [n.key, n]));
    const canonical = key => all.get(key)?.mirrorOf || key;
    const visible = nodes.filter(n => !n.mirrorOf).map(n => ({ ...n, parentKey: canonical(n.parentKey) }));
    const map = new Map(visible.map(n => [n.key, n]));
    // 一次建立父子索引，大树布局不再为每个节点重复扫描整个列表。
    const childrenByKey=new Map();
    for(const n of visible)if(n.parentKey&&!n.unresolved){const list=childrenByKey.get(n.parentKey)||[];list.push(n);childrenByKey.set(n.parentKey,list);}
    const children = key => childrenByKey.get(key)||[];
    // 按各层轮廓紧凑拼接子树，深层叶子不会把上层兄弟无限撑开。
    const arrange = node => {
      const branches = (node ? children(node.key) : visible.filter(n => n.unresolved || !n.parentKey || !map.has(n.parentKey))).map(arrange);
      const offsets = [], left = [], right = []; const gap = 220;
      for (const branch of branches) {
        let offset = 0;
        if (offsets.length) for (let level = 0; level < Math.min(right.length, branch.left.length); level++) {
          offset = Math.max(offset, right[level] + gap - branch.left[level]);
        }
        offsets.push(offset);
        branch.left.forEach((x, level) => { left[level] = Math.min(left[level] ?? Infinity, x + offset); });
        branch.right.forEach((x, level) => { right[level] = Math.max(right[level] ?? -Infinity, x + offset); });
      }
      const center = offsets.length ? (offsets[0] + offsets.at(-1)) / 2 : 0;
      const points = [{ node, x: 0, level: 0 }];
      branches.forEach((branch, i) => { for (const p of branch.points) points.push({ ...p, x: p.x + offsets[i] - center, level: p.level + 1 }); });
      return { points, left: [0, ...left.map(x => x - center)], right: [0, ...right.map(x => x - center)] };
    };
    const arranged = arrange(null);
    // 画布左右留白以项目根为轴取相同距离；父节点位于首末直接子节点中点。
    const extent = Math.max(350, ...arranged.points.map(p => Math.abs(p.x) + 170));
    const width = extent * 2, root = { x: extent, y: 90 };
    const placed = arranged.points.filter(p => p.node).map(p => ({ ...p.node, x: p.x + extent, y: 270 + (p.level - 1) * 220 }));
    const positions = new Map(placed.map(n => [n.key, n]));
    const edges = placed.map(n => ({ from: !n.unresolved && positions.get(n.parentKey) || root, to: n }));
    return { nodes: placed, edges, root, width, height: Math.max(500, ...placed.map(n => n.y + 180)) };
  }
  // 宽树首次打开定位根球；刷新正文或用户手动滚动时不抢回视角。
  function treeScrollLeft(model, viewportWidth) { return Math.max(0, model.root.x - viewportWidth / 2); }
  // 项目位置采用稳定随机散布，刷新不会整屏跳位；数量只影响有限范围内的球径。
  const projectSide = p => p.sources.includes('codex') ? 'codex' : 'dsh';
  const projectSize = count => Math.min(156, 88 + Math.log2(1 + Math.max(0, count || 0)) * 12);
  function scatterProjects(projects, width, height) {
    const placed = []; width = Math.max(260, width); height = Math.max(400, height);
    let seed = 74129; const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (const p of projects) {
      const size = projectSize(p.count); let x, y, found = false;
      for (let attempt = 0; !found; attempt++) {
        if (attempt && attempt % 100 === 0) height += 180;
        x = size / 2 + 20 + random() * Math.max(0, width - size - 40);
        y = size / 2 + 25 + random() * Math.max(0, height - size - 50);
        found = placed.every(q => Math.hypot(q.x-x,q.y-y) > (q.size+size)/2 + 28);
      }
      placed.push({ ...p, size, x, y });
    }
    return { projects: placed, height };
  }
  // 同一路径的项目可在主页、侧栏、树根之间连续移动；代理层跨过滚动容器的裁剪边界。
  function createOrbitalMotion(root, layer) {
    const duration=520, easing='cubic-bezier(.22,.75,.22,1)';
    let previous=new Map(), pending=null;
    const ghosts=new Map(), animations=new Set();
    const rectOf=el=>{const r=el.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};};
    // 快照只读几何；真正需要移动的可见球才克隆，避免轮询复制整棵 DOM 树。
    const snapshot=()=>new Map([...root.querySelectorAll('[data-motion-key]')].map(el=>{
      const key=el.dataset.motionKey, proxy=ghosts.get(key)?.el, visual=proxy||el;
      return [key,{el:visual,rect:rectOf(visual),compact:el.dataset.motionCompact==='true',opacity:proxy?Number(getComputedStyle(proxy).opacity):1,side:el.dataset.motionSide||'dsh'}];
    }).filter(([,item])=>item.rect.width>0&&item.rect.height>0));
    const run=(el,frames,options={})=>{
      const animation=el.animate(frames,{duration,easing,fill:'both',...options});animations.add(animation);root.classList.add('dots-animating');
      const settled=()=>{animations.delete(animation);if(!animations.size)root.classList.remove('dots-animating');};
      animation.finished.then(()=>{settled();animation.cancel();},settled);return animation;
    };
    const clear=()=>{for(const a of animations)a.cancel();animations.clear();for(const g of ghosts.values())g.el.remove();ghosts.clear();root.classList.remove('dots-animating');};
    const capture=()=>{
      pending=snapshot();
      // 筛掉后又迅速输入回来时，从尚未退场完毕的代理接续，避免从屏幕外重新起步。
      for(const [key,g] of ghosts)if(!pending.has(key))pending.set(key,{...g,rect:rectOf(g.el),opacity:Number(getComputedStyle(g.el).opacity)});
    };
    const play=()=>{
      const before=pending||previous;pending=null;
      clear();
      // 所有目标坐标集中读取，完成后再创建代理和写样式，避免读写交错触发多次布局。
      const after=snapshot();
      if(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches){previous=after;return;}
      const area=rectOf(root), onScreen=r=>r.left+r.width>area.left&&r.left<area.left+area.width&&r.top+r.height>area.top&&r.top<area.top+area.height;
      const proxy=(key,old,target)=>{
        if(!onScreen(old.rect)&&(!target||!onScreen(target.rect)))return;
        const el=old.el.cloneNode(true);
        if(old.compact){const ball=el.querySelector('.dots-ball'),title=el.querySelector('strong'),sub=el.querySelector('small');if(ball)ball.style.padding='8px';if(title)title.style.fontSize='10px';if(sub)sub.style.display='none';}
        el.removeAttribute('data-motion-key');el.setAttribute('aria-hidden','true');el.inert=true;
        Object.assign(el.style,{position:'absolute',margin:'0',left:(old.rect.left-area.left)+'px',top:(old.rect.top-area.top)+'px',width:old.rect.width+'px',height:old.rect.height+'px',transform:'none',translate:'none',animation:'none',transformOrigin:'0 0',pointerEvents:'none'});
        layer.append(el);const item={el,side:old.side,compact:old.compact};ghosts.set(key,item);
        const dx=target?target.rect.left-old.rect.left:(old.side==='codex'?area.left-old.rect.left-old.rect.width-40:area.left+area.width-old.rect.left+40);
        const dy=target?target.rect.top-old.rect.top:24;
        const sx=target?target.rect.width/old.rect.width:.72, sy=target?target.rect.height/old.rect.height:.72;
        const motion=run(el,[{transform:'translate(0,0) scale(1)',opacity:old.opacity??1},{transform:`translate(${dx}px,${dy}px) scale(${sx},${sy})`,opacity:target?1:0,offset:.82},{transform:`translate(${dx}px,${dy}px) scale(${sx},${sy})`,opacity:0}]);
        if(target)run(target.el,[{opacity:0},{opacity:0,offset:.76},{opacity:1}]);
        motion.finished.then(()=>{if(ghosts.get(key)===item){el.remove();ghosts.delete(key);}},()=>{});
      };
      for(const [key,item] of after){
        const old=before.get(key);
        if(old){
          const changed=['left','top','width','height'].some(k=>Math.abs(old.rect[k]-item.rect[k])>.5);
          if(changed)proxy(key,old,item);
        }else if(onScreen(item.rect)){
          const dx=item.side==='codex'?-90:90;
          run(item.el,[{transform:`translate(${dx}px,28px) scale(.84)`,opacity:0},{transform:'translate(0,0) scale(1)',opacity:1}]);
        }
      }
      for(const [key,item] of before)if(!after.has(key))proxy(key,item,null);
      previous=after;
    };
    return {capture,play,dispose:clear};
  }
  const css = `
.dots-orbit{container-type:inline-size;height:100%;min-height:0;display:flex;flex-direction:column;position:relative;isolation:isolate;overflow:hidden;color:var(--dsw-alias-label-primary,#26344c);font:14px/1.6 system-ui,sans-serif;background:radial-gradient(ellipse at 20% 20%,#b9c8fa30,transparent 60%),radial-gradient(ellipse at 85% 70%,#a0e6d329,transparent 55%),var(--dsw-alias-background-primary,#f8fafc)}
.dots-orbit *{box-sizing:border-box}.dots-orbit button,.dots-orbit input,.dots-orbit textarea,.dots-orbit select{font:inherit;color:inherit}.dots-orbit button{cursor:pointer}.dots-orbit button:disabled{opacity:.45;cursor:wait}.dots-bar{padding:20px 26px;display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,680px) minmax(0,1fr);gap:18px;align-items:center;z-index:3;border-bottom:1px solid #9baec71a}.dots-actions{grid-column:3;display:flex;justify-self:end;align-items:center;gap:10px;white-space:nowrap}.dots-actions .dots-back{font-weight:650;color:#334c7b;background:#b6c9f580;border-color:#8ea9df90;box-shadow:0 4px 16px #7793cc24;padding-inline:20px}.dots-actions .dots-back:hover{background:#adc3f5b0}.dots-spacer{flex:1}.dots-chip{border:1px solid #9eafce40;background:#ffffff32;backdrop-filter:blur(18px);border-radius:24px;padding:7px 14px}.dots-search{grid-column:2;width:100%;min-width:0;border:1px solid #9eafce45;background:#ffffff50;backdrop-filter:blur(18px);border-radius:28px;padding:12px 22px;outline:none;transition:border-color .2s,box-shadow .2s}.dots-search:focus{border-color:#91aadc;box-shadow:0 0 0 3px #9eafd222}.dots-legend{padding:10px 26px;display:flex;gap:20px;font-size:12px;opacity:.75}.dots-dot{display:inline-block;width:9px;height:9px;margin-right:7px;border-radius:50%;background:#a9b9f1}.dots-dot.dsh{background:#8bd7bf}.dots-workspace{display:flex;flex:1;min-height:0;position:relative}.dots-space{flex:1;min-width:0;overflow:auto;position:relative;scroll-behavior:smooth}.dots-galaxy{position:relative;min-height:100%;width:100%}.dots-project-orbit{position:relative;width:150px;height:150px;transform-origin:0 0}
.dots-ball{border-radius:50%;border:1px solid #ffffffb0;background:radial-gradient(circle at 28% 20%,#ffffffb0,transparent 62%),linear-gradient(135deg,#c6d5ff70,#cfc4f24d);backdrop-filter:blur(18px) saturate(135%);box-shadow:inset 0 0 24px #ffffff40,0 16px 45px #667bb21a,0 3px 8px #8094bd12;display:flex;align-items:center;justify-content:center;flex-direction:column;text-align:center;padding:18px;transition:transform .3s,border-color .3s;width:100%;height:100%;overflow-wrap:anywhere}
.dots-ball.dsh{background:radial-gradient(circle at 28% 20%,#ffffffb0,transparent 62%),linear-gradient(135deg,#bcecd770,#bde3eb4d)}.dots-ball:hover,.dots-ball:focus-visible{transform:scale(1.08);box-shadow:inset 0 0 24px #ffffff60,0 18px 48px #6d86b92c;border-color:#fff;outline:2px solid #9eafd233;outline-offset:4px}.dots-ball strong{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;font-size:14px;font-weight:550;line-height:1.5}.dots-ball small{font-size:10px;opacity:.65;margin-top:7px}.dots-project-orbit>.dots-ball{animation:dots-breathe 7s ease-in-out infinite;animation-delay:var(--delay,0s)}.dots-project-orbit>.dots-ball strong{font-size:16px}.dots-rail{width:94px;flex-shrink:0;overflow-y:auto;padding:32px 8px;display:flex;flex-direction:column;gap:28px;align-items:center}.dots-rail .dots-project-orbit{width:70px;height:70px;flex-shrink:0;transform-origin:0 0}.dots-rail .dots-ball{padding:8px}.dots-rail .dots-ball strong{font-size:10px;-webkit-line-clamp:2}.dots-rail small{display:none}.dots-map{position:relative;margin:10px auto 40px;animation:dots-veil .4s ease-out}.dots-node{position:absolute;width:120px;height:120px;transform-origin:0 0;z-index:1}.dots-node:hover{z-index:5}.dots-node.root{width:140px;height:140px}.dots-node>.dots-ball{animation:dots-breathe 7s ease-in-out infinite}.dots-node:nth-child(2n)>.dots-ball{animation-delay:-3s}.dots-node.selected>.dots-ball{outline:2px solid #9caedc88;outline-offset:6px}.dots-node.pending>.dots-ball{border-style:dashed}.dots-satellites{position:absolute;left:105px;top:-30px;width:102px;height:180px;visibility:hidden;opacity:0;pointer-events:none;transform:translateX(-8px);transition:.2s}.dots-node:hover .dots-satellites{visibility:visible;opacity:1;pointer-events:auto;transform:translateX(0)}.dots-satellite{position:absolute;width:44px;height:44px;padding:3px;border-radius:50%;border:1px solid #ffffffc9;background:#e3eafaeb;backdrop-filter:blur(15px);box-shadow:0 5px 18px #8194c425;font-size:11px!important}.dots-satellite:hover{transform:scale(1.12);background:#edf4ff}.dots-satellite:nth-child(1){left:0;top:0}.dots-satellite:nth-child(2){left:47px;top:36px}.dots-satellite:nth-child(3){left:55px;top:91px}.dots-satellite:nth-child(4){left:13px;top:136px}.dots-node-note{position:absolute;top:136px;left:-38px;width:196px;text-align:center;font-size:11px;opacity:.7;pointer-events:none}.dots-links{position:absolute;inset:0;overflow:visible;pointer-events:none}.dots-links path{fill:none;stroke:#9caed575;stroke-width:1.5;stroke-dasharray:5 7;animation:dots-flow 24s linear infinite}.dots-links text{font-size:11px;fill:currentColor;opacity:.65;paint-order:stroke;stroke:var(--dsw-alias-background-primary,#f8fafc);stroke-width:4px;stroke-linejoin:round}
.dots-motion-layer{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:8}.dots-motion-layer *{pointer-events:none!important}.dots-motion-layer .dots-satellites{display:none}
/* 移动阶段只合成位移/透明度，暂停重复模糊采样与线条重绘；结束后恢复毛玻璃。 */
.dots-workspace.dots-animating .dots-ball,.dots-motion-layer .dots-ball{backdrop-filter:none;animation-play-state:paused;box-shadow:inset 0 0 16px #ffffff40,0 8px 24px #667bb21a}
.dots-workspace.dots-animating .dots-links path{animation-play-state:paused}
/* 弹窗遮挡期间冻结背景悬浮与虚线，避免全屏模糊层随背景逐帧重绘。 */
.dots-workspace[data-modal-open=true] .dots-ball,.dots-workspace[data-modal-open=true] .dots-links path{animation-play-state:paused}
.dots-notices{position:absolute;bottom:16px;left:50%;transform:translateX(-50%);width:min(760px,calc(100% - 32px));max-height:40%;overflow:auto;z-index:30;pointer-events:none;display:flex;flex-direction:column;gap:8px}.dots-notices>div{pointer-events:auto;flex-shrink:0;border:1px solid #ffffffa0;border-radius:16px;backdrop-filter:blur(20px);box-shadow:0 8px 28px #42557920;background:#eef6f5ed;animation:dots-reveal .2s ease-out;overflow-wrap:anywhere}.dots-notices>.dots-error{background:#fff0f0ed}
.dots-modal-layer{position:absolute;inset:0;z-index:20;display:grid;place-items:center;grid-template-rows:minmax(0,1fr);grid-template-columns:minmax(0,1fr);padding:24px;background:#a8b8d324;backdrop-filter:blur(5px);animation:dots-veil .32s ease-out}.dots-drawer{width:min(880px,100%);height:auto;max-height:min(860px,100%);min-height:0;display:flex;flex-direction:column;overflow:hidden;border:1px solid #ffffffb0;border-radius:28px;background:linear-gradient(135deg,#f6f8fff2,#edf8f5ed);color:#26344c;box-shadow:0 28px 90px #33486d29,inset 0 1px 0 #fff;backdrop-filter:blur(30px) saturate(125%);animation:dots-window .36s cubic-bezier(.22,.75,.22,1);outline:none}.dots-modal-layer.closing{animation:dots-veil-out .24s ease-in both;pointer-events:none}.dots-modal-layer.closing .dots-drawer{animation:dots-window-out .24s ease-in both}.dots-satellite.danger{color:#a94f60;background:#fae8eceb}.dots-node.root .dots-satellites{left:126px;top:-12px}.dots-drawer-head{background:#ffffff30}.dots-drawer-head{display:flex;gap:8px;align-items:center;padding:16px 20px;border-bottom:1px solid #aabbd530}.dots-drawer-head button{flex-shrink:0}.dots-drawer-head strong{flex:1;min-width:0;overflow-wrap:anywhere}.dots-drawer-body{overflow:auto;overscroll-behavior:contain;padding:20px;flex:0 1 auto;min-height:0}.dots-drawer-head,.dots-tabs{flex-shrink:0}.dots-tabs{display:flex;gap:8px;padding:10px 20px;flex-wrap:wrap}.dots-tabs .active{background:#b4c6ef40}.dots-form label{display:block;margin:14px 0 6px;font-size:12px}.dots-form input,.dots-form textarea,.dots-form select{width:100%;border:1px solid #9eafce60;background:var(--dsw-alias-background-primary,#fff);border-radius:12px;padding:10px}.dots-form textarea{min-height:96px;resize:vertical}.dots-form input[type=checkbox]{width:auto}.dots-primary{background:#9bb6ed45;border:1px solid #92acdf70}.dots-note{font-size:12px;opacity:.7;white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0}.dots-error{padding:10px 26px;color:#bf5555;background:#c55b5b0c;white-space:pre-wrap;font-size:12px}.dots-progress{padding:8px 26px;font-size:12px;background:#b9d7c822}.dots-message{margin:0 0 24px;overflow-wrap:anywhere}.dots-message.user{background:#b6ccef22;border-radius:18px;padding:12px 16px}.dots-message pre,.dots-message table{overflow:auto;max-width:100%}.dots-message .dots-source{white-space:pre-wrap;font-size:11px}.dots-role{font-size:11px;opacity:.6;margin-bottom:8px}.dots-empty{padding:50px 30px;text-align:center;opacity:.6}.dots-run{border:1px solid #aabbd540;border-radius:15px;padding:12px;margin:12px 0;font-size:12px}.dots-run progress{width:100%}.dots-close{border:0;background:transparent;font-size:20px!important}
@keyframes dots-veil{from{opacity:0}to{opacity:1}}@keyframes dots-window{from{opacity:0;transform:translateY(36px) scale(.95)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes dots-window-out{from{opacity:1;transform:translateY(0) scale(1)}to{opacity:0;transform:translateY(28px) scale(.97)}}@keyframes dots-veil-out{from{opacity:1}to{opacity:0}}
@keyframes dots-dock{from{opacity:0;transform:scale(1.7) translateX(30px)}to{opacity:1;transform:scale(1) translateX(0)}}@keyframes dots-breathe{0%,100%{translate:0 0}50%{translate:0 -5px}}@keyframes dots-float{0%,100%{transform:translateY(0) rotate(-1deg)}50%{transform:translateY(-12px) rotate(1deg)}}@keyframes dots-flow{to{stroke-dashoffset:-240}}@keyframes dots-reveal{from{opacity:0;transform:translateY(15px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:900px){.dots-rail{width:68px;padding:26px 5px}.dots-rail .dots-project-orbit{width:54px;height:54px}.dots-modal-layer{padding:12px}.dots-drawer{width:100%;height:auto;max-height:100%;border-radius:20px}.dots-galaxy{gap:38px;padding:45px 25px}.dots-project-orbit{width:125px;height:125px}.dots-bar{padding:14px}}
@container (max-width:1440px){.dots-bar{grid-template-columns:minmax(0,1fr);gap:12px}.dots-search{grid-column:1;grid-row:1;width:min(680px,100%);justify-self:center}.dots-actions{grid-column:1;grid-row:2;flex-wrap:wrap}}
@media(prefers-reduced-motion:reduce){.dots-orbit *{animation:none!important;scroll-behavior:auto;transition:none!important}}
`;
  function OrbitalPage({ ctx }) {
    const [projects,setProjects] = useState([]), [project,setProject] = useState(''), [tree,setTree] = useState(null), [filter,setFilter] = useState('');
    const [selected,setSelected] = useState(''), [tab,setTab] = useState('history'), [drawer,setDrawer] = useState(false);
    const [error,setError] = useState(''), [busy,setBusy] = useState(false), [messages,setMessages] = useState([]), [runs,setRuns] = useState([]);
    const [title,setTitle] = useState(''), [intent,setIntent] = useState(''), [parentKey,setParentKey] = useState(''), [summary,setSummary] = useState(false), [goal,setGoal] = useState('');
    const [pendingOpen,setPendingOpen] = useState(''), [historyLoading,setHistoryLoading] = useState(false);
    const [showInternal,setShowInternal] = useState(false), [spaceSize,setSpaceSize] = useState({width:900,height:650});
    const [deletion,setDeletion]=useState(null), [closing,setClosing]=useState(false), [deletionReports,setDeletionReports]=useState([]), [showUnavailable,setShowUnavailable]=useState(false), [serverInfo,setServerInfo]=useState(null);
    const [dismissedNotices,setDismissedNotices]=useState(new Set()), [entryHint,setEntryHint]=useState(0);
    // 单击只提示；浏览器 dblclick 识别同一球上的快速双击，避免跨球误进入。
    useEffect(()=>{if(!entryHint)return;const timer=setTimeout(()=>setEntryHint(0),5000);return()=>clearTimeout(timer);},[entryHint]);
    const projectGeometry=useRef(''), treeGeometry=useRef('');
    const noticeTimers=useRef(new Map()), workspaceRef=useRef(null), motionLayerRef=useRef(null), motionRef=useRef(null), overviewScroll=useRef(0);
    const captureMotion=()=>motionRef.current?.capture();
    const chooseProject=value=>{const change=()=>{captureMotion();if(!project&&spaceRef.current)overviewScroll.current=spaceRef.current.scrollTop;setTree(null);setProject(value);};if(drawer)closeDialog(change);else change();};
    const spaceRef = useRef(null), centeredTree = useRef(null), dialogRef=useRef(null), closeTimer=useRef(null);
    // 关闭动作立即取消历史请求，不等待退场动画或历史分页结束。
    const historyRequest=useRef(null);
    const closeDialog=after=>{historyRequest.current?.abort();setClosing(true);clearTimeout(closeTimer.current);closeTimer.current=setTimeout(()=>{setDrawer(false);setClosing(false);setPendingOpen('');setDeletion(null);if(typeof after==='function')after();},240);};
    // 窗口进入后聚焦，Esc 关闭；关闭动画不改变树的宽度与滚动位置。
    useEffect(()=>{if(!drawer)return;const previous=document.activeElement;dialogRef.current?.focus();return()=>{clearTimeout(closeTimer.current);previous?.focus?.();};},[drawer]);
    useEffect(()=>{const el=spaceRef.current;if(!el||typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(entries=>{const r=entries[0].contentRect;if(r.width>0&&r.height>0){captureMotion();setSpaceSize({width:r.width,height:r.height});}});observer.observe(el);return()=>observer.disconnect();},[project]);
    // 提醒按内容和任务状态计时；轮询得到相同结果不会重新弹出或延长时间。
    const noticeKeys=[
      ...(error?['error:'+project+':'+error]:[]),
      ...(serverInfo&&!serverInfo.capabilities.includes('permanent-delete-v1')?['server-reload']:[]),
      ...(tree?.loading?.errors?.length?['index:'+project+':'+tree.loading.errors.join('\n')]:[]),
      ...deletionReports.filter(r=>r.status!=='completed').map(r=>'delete:'+r.file+':'+r.status+':'+r.errors.join('；')),
    ];
    const noticeSignature=JSON.stringify(noticeKeys);
    useEffect(()=>{
      for(const key of noticeKeys)if(!noticeTimers.current.has(key)){
        const timer=setTimeout(()=>{setDismissedNotices(previous=>new Set([...previous,key]));noticeTimers.current.set(key,null);},5000);
        noticeTimers.current.set(key,timer);
      }
    },[noticeSignature]);
    useEffect(()=>()=>{for(const timer of noticeTimers.current.values())if(timer)clearTimeout(timer);},[]);
    const noticeVisible=key=>!dismissedNotices.has(key);
    const standalone=project===STANDALONE;
    const canClose=!busy||tab==='history';
    const node = tree?.nodes.find(n => n.key === selected), currentProject = projects.find(p => p.path === project);
    const current = ctx.uiSession.adapter.current;
    const session = useSyncExternalStore(fn => current.subscribe(fn), () => current.getSnapshot());
    const owner = session.key || '';
    const act = async fn => { setBusy(true); setError(''); try { await fn(); } catch(e) { setError(e.message); } finally { setBusy(false); } };
    const discover = async signal => { const data = await api('conversation-projects',{},undefined,signal); const geometry=JSON.stringify(data.projects.map(p=>[p.path,p.count,p.sources]));if(geometry!==projectGeometry.current){captureMotion();projectGeometry.current=geometry;}setProjects(data.projects);setServerInfo({version:data.pluginVersion,capabilities:data.capabilities||[]});setDeletionReports(data.deletions||[]); if(data.errors?.length) setError(data.errors.join('\n')); };
    useEffect(() => { const c=new AbortController();let timer;const poll=async()=>{try{await discover(c.signal);}catch(e){if(!c.signal.aborted)setError(e.message);}if(!c.signal.aborted)timer=setTimeout(poll,10000);};void poll();return()=>{c.abort();clearTimeout(timer);}; },[]);
    // 切换项目或关闭页面时取消旧轮询，避免旧项目结果覆盖当前球群。
    useEffect(() => {
      if(!project)return; const c=new AbortController(); let timer;
      setTree(null);setSelected('');setDrawer(false);setClosing(false);setDeletion(null);setPendingOpen('');setError('');
      const poll=async()=>{try{const data=await api('conversation-tree',{project,owner},undefined,c.signal);if(!c.signal.aborted){const geometry=JSON.stringify(data.nodes.map(n=>[n.key,n.parentKey,n.mirrorOf,n.hiddenReason,n.internal,n.empty,!!n.unavailable,n.unresolved]));if(geometry!==treeGeometry.current){captureMotion();treeGeometry.current=geometry;}setTree(data);}}catch(e){if(!c.signal.aborted)setError(e.message);}if(!c.signal.aborted)timer=setTimeout(poll,2500);};
      void poll(); // 先显示磁盘树，索引请求不再挡住第一次渲染。
      if(!standalone)api('conversation-sync',{}, {project,includeArchived:true},c.signal).catch(e=>{if(!c.signal.aborted)setError(e.message);});
      return()=>{c.abort();clearTimeout(timer);};
    },[project,owner]);
    useEffect(()=>{ const c=new AbortController();let timer;
      const poll=async()=>{try{const data=await api('state',{owner},undefined,c.signal);if(!c.signal.aborted)setRuns(data.runs);}catch(e){if(!c.signal.aborted)setError(e.message);}if(!c.signal.aborted)timer=setTimeout(poll,1000);};
      void poll();return()=>{c.abort();clearTimeout(timer);};
    },[owner]);
    useEffect(()=>{ if(!selected||!project||!drawer||tab!=='history'||closing)return;if(node?.unavailable){setMessages([]);setHistoryLoading(false);return;}const c=new AbortController();let timer;historyRequest.current=c;setMessages([]);setHistoryLoading(true);
      const poll=async()=>{try{const data=await api('conversation-history',{project,key:selected},undefined,c.signal);if(!c.signal.aborted){setMessages(data.messages);setHistoryLoading(false);}}catch(e){if(!c.signal.aborted){setError(e.message);setHistoryLoading(false);}}if(!c.signal.aborted)timer=setTimeout(poll,3500);};
      void poll();return()=>{c.abort();clearTimeout(timer);};
    },[project,selected,drawer,tab,closing,node?.unavailable]);
    // 宿主 openSession 自己切换主视图；DSH 原生会话无需经过项目复制门槛。
    const nativeOpen=id=>ctx.uiWorkspace.openSession(id);
    const complete=tree && tree.lastCopyAt && tree.nodes.filter(n=>!n.mirrorOf&&!n.internal&&!n.hiddenReason&&!n.unavailable&&n.source==='codex').every(n=>n.dshSessionId) && !tree.copy?.running && !tree.copy?.errors?.length;
    useEffect(()=>{if(pendingOpen&&complete){const n=tree.nodes.find(n=>n.key===pendingOpen);setPendingOpen('');if(n?.unavailable)setError('该对话历史不可用，已跳过复制：'+n.unavailable);else if(n)nativeOpen(n.source==='dsh'?n.id:n.dshSessionId);}},[pendingOpen,complete,tree]);
    const pick=(n,mode)=>{clearTimeout(closeTimer.current);setClosing(false);setDeletion(null);setPendingOpen('');setSelected(n.key);setTab(mode);setDrawer(true);setTitle(n.title+' · 分支');setIntent(n.intent||'');setParentKey(n.parentKey||'');setSummary(false);setGoal('');};
    const enter=n=>{if(n.unavailable){pick(n,'history');setError('该历史不可用：'+n.unavailable);return;}if(standalone&&n.source==='codex'){pick(n,'history');return;}if(n.source==='dsh'||complete)nativeOpen(n.source==='dsh'?n.id:n.dshSessionId);else{pick(n,'copy');setPendingOpen(n.key);}};
    const rootAction=mode=>{clearTimeout(closeTimer.current);setClosing(false);setSelected('');setPendingOpen('');setDeletion(null);setDrawer(true);setTab(mode);setTitle('新对话');setIntent('');setSummary(false);};
    const askDelete=n=>act(async()=>{if(!serverInfo?.capabilities.includes('permanent-delete-v1')){const data=await api('conversation-projects');setServerInfo({version:data.pluginVersion,capabilities:data.capabilities||[]});if(!data.capabilities?.includes('permanent-delete-v1'))throw Error('当前 DSH 后端尚未加载删除功能，请完全退出 DSH 后重新启动。');}const plan=await api('conversation-delete-plan',{}, {project,key:n?.key});setSelected(n?.key||'');setPendingOpen('');setDeletion({...plan,step:1});setTab('delete');setClosing(false);setDrawer(true);});
    const confirmDelete=()=>act(async()=>{const result=await api('conversation-delete-confirm',{}, {token:deletion.token,step:deletion.step});if(deletion.step===1){setDeletion(d=>({...d,step:2}));return;}setDeletion({...deletion,step:3,result});setTree(await api('conversation-tree',{project,owner}));await discover();});
    // 返回逐层退出操作窗口、项目树和星图，不改变当前原生对话。
    const goBack=()=>{if(drawer)closeDialog();else if(project)chooseProject('');else ctx.layout.selectPanel(null);};
    const copy=()=>act(async()=>{const progress=await api('conversation-copy',{}, {project});setTree(t=>({...t,copy:progress}));});
    const refresh=()=>act(async()=>{const result=await api('conversation-sync',{}, {project,includeArchived:true});setTree(result);if(result.errors.length)setError(result.errors.join('\n'));await discover();});
    // 已迁移项目从 DSH 副本分支，保留用户迁移后的续聊。
    const create=()=>act(async()=>{const result=await api('conversation-create',{}, {project,parentKey:tab==='new'?undefined:(node?.dshSessionId?'dsh:'+node.dshSessionId:selected),title,intent,summarize:summary,owner});captureMotion();setTree(result.tree);setSelected(result.key);closeDialog();if(result.summaryError)setError('分支已创建，摘要未完成：'+result.summaryError);});
    const saveLink=()=>act(async()=>setTree(await api('conversation-link',{}, {project,key:selected,parentKey,intent})));
    const summarize=()=>act(async()=>{await api('conversation-link',{}, {project,key:selected,parentKey,intent});setTree(await api('conversation-summary',{}, {project,key:selected,owner}));});
    const submitDots=()=>act(async()=>{const result=await api(node?.source==='codex'?'continue':'conversation-dots',{}, {project,key:selected,owner,threadId:node?.id,goal});setGoal('');setError('');setIntent(result.message);});
    const visible=useMemo(()=>(tree?.nodes||[]).filter(n=>!n.hiddenReason&&!n.id?.startsWith('selectionchat-temp-')&&(showInternal||!n.internal)&&(showUnavailable||(!n.unavailable&&!n.empty))),[tree?.nodes,showInternal,showUnavailable]);
    const model=useMemo(()=>layoutTree(visible),[visible]);
    const structure = visible.map(n => n.key + ':' + (n.parentKey || '') + ':' + !!n.unresolved + ':' + (n.mirrorOf || '')).join('|');
    useLayoutEffect(()=>{
      const el=spaceRef.current;if(!el)return;
      if(!project){el.scrollTop=overviewScroll.current;centeredTree.current=null;return;}
      const identity=project+'\n'+structure;
      if(centeredTree.current===identity)return;
      el.style.scrollBehavior='auto';
      el.scrollLeft=treeScrollLeft(model,el.clientWidth);
      if(centeredTree.current?.split('\n')[0]!==project)el.scrollTop=0;
      el.style.scrollBehavior='';
      centeredTree.current=identity;
    },[project,structure,!!tree]);
    // 同一份实时筛选结果供主页和两侧项目使用，不需要点击搜索或发起模型请求。
    const query=filter.trim().toLocaleLowerCase();
    const matchingProjects=useMemo(()=>projects.filter(p=>!query||p.title.toLocaleLowerCase().includes(query)),[projects,query]);
    const scattered=useMemo(()=>scatterProjects(matchingProjects,spaceSize.width,spaceSize.height),[matchingProjects,spaceSize.width,spaceSize.height]);
    const motionSignature=JSON.stringify([project,query,structure,spaceSize.width,spaceSize.height,projects.map(p=>[p.path,p.count,p.sources])]);
    useLayoutEffect(()=>{
      if(!workspaceRef.current||!motionLayerRef.current)return;
      motionRef.current ||= createOrbitalMotion(workspaceRef.current,motionLayerRef.current);
      motionRef.current.play();
    },[motionSignature]);
    useEffect(()=>()=>motionRef.current?.dispose(),[]);
    const found=[...runs].reverse().find(r=>r.workers.some(w=>w.threadId===node?.id||w.childId===node?.id));
    const worker=found?.workers.find(w=>w.threadId===node?.id||w.childId===node?.id);
    // 增量正文覆盖同 ID 落盘消息，暂停后仍刷新完整历史，不把 done 当作正文。
    let display=messages;
    if(node?.source==='codex'&&worker?.liveTurn){const indexed=new Map(messages.map(m=>[m.id,m]));for(const item of worker.liveTurn.items){const old=indexed.get(item.id);if(!old||(item.text||'').length>=(old.text||'').length)indexed.set(item.id,{id:item.id,role:item.type==='agentMessage'?'assistant':item.type==='userMessage'?'user':'tool',text:item.text});}display=[...indexed.values()];}
    const projectBall=(p,i)=>h('div',{key:p.path,className:'dots-project-orbit','data-motion-key':'project:'+p.path,'data-motion-side':projectSide(p),'data-motion-compact':String(p.x==null),style:{'--delay':(-i*.83)+'s',...(p.x!=null?{position:'absolute',left:p.x-p.size/2,top:p.y-p.size/2,width:p.size,height:p.size}: {})}},h('button',{className:'dots-ball '+(projectSide(p)),title:p.standalone?'Codex 和 DSH 中未归入项目的对话':p.path,onClick:()=>chooseProject(p.path)},h('strong',null,p.title),h('small',null,(projectSide(p)==='codex'?'CODEX':'DEEPSEEK')+' · '+(p.count||0))));
    const others=matchingProjects.filter(p=>p.path!==project);
    const button=(text,onClick,disabled=false)=>h('button',{className:'dots-chip',onClick,disabled},text);
    const field=(label,value,set,multiline=false)=>h('label',null,label,h(multiline?'textarea':'input',{value,onChange:e=>set(e.target.value)}));
    const form=h('div',{className:'dots-form'},
      tab==='delete'&&deletion&&h(React.Fragment,null,h('h3',null,deletion.step===1?'第一次确认：删除范围':deletion.step===2?'第二次确认：永久删除历史':'删除处理结果'),h('p',null,deletion.title),h('p',{className:'dots-note'},`Codex ${deletion.codexCount} 个 · DSH ${deletion.dshCount} 个对话。${deletion.scope==='project'?'包含项目中的子代理和迁移副本。':'只删除此对话及其迁移副本，不级联删除分支。'} 项目代码和文件保留。`),h('p',{className:'dots-note'},'历史无法从插件恢复。Codex 通过原生接口删除；DSH 日志在完全退出应用后清理。请等清理完成再启动 DSH。'),deletion.step<3?h(React.Fragment,null,button(deletion.step===1?'确认范围，继续':'再次确认，永久删除',confirmDelete,busy),button('取消',closeDialog,busy)):h(React.Fragment,null,h('p',{role:'status'},deletion.result.message),deletion.result.receipt&&h('p',{className:'dots-note'},deletion.result.receipt),deletion.result.errors?.length>0&&h('p',{className:'dots-error'},deletion.result.errors.join('\n')),button('完成',()=>closeDialog(()=>{if(deletion.scope==='project'&&!deletion.result.errors?.length){captureMotion();setTree(null);setProject('');}})))),
      tab==='new'&&h('label',null,h('input',{type:'checkbox',checked:!!tree?.autoSummaries,onChange:e=>{const enabled=e.target.checked;void act(async()=>setTree(await api('conversation-settings',{}, {project,autoSummaries:enabled})));}}),' 自动用 DeepSeek 总结新分支（消耗额度）'),
      (tab==='branch'||tab==='new')&&h(React.Fragment,null,field('对话标题',title,setTitle),field('分支原因 / 新目标',intent,setIntent,true),tab==='branch'&&h('label',null,h('input',{type:'checkbox',checked:summary,onChange:e=>setSummary(e.target.checked)}),' 使用 DeepSeek 总结原因（消耗模型额度）'),button(tab==='new'?'创建对话':'创建分支',create,busy)),
      tab==='copy'&&h(React.Fragment,null,h('p',null,'将整个项目的对话历史复制到 DSH，随后可直接点击对话球继续。'),h('p',{className:'dots-note'},'项目文件保留在当前目录；Codex 原对话保留。已有副本不重复复制、不覆盖你在 DSH 中的新消息。运行中的 Codex 对话需暂停后再复制。'),button(tree?.copy?.running?'正在复制…':'确认复制整个项目到 DSH',copy,busy||tree?.copy?.running),tree?.copy&&h('p',{className:'dots-note'},`${tree.copy.phase} ${tree.copy.done}/${tree.copy.total}\n${tree.copy.errors.join('\n')}${tree.copy.skipped?.length?'\n已跳过不可用记录：\n'+tree.copy.skipped.join('\n'):''}`),pendingOpen&&button('取消自动进入',()=>setPendingOpen(''))),
      tab==='relation'&&h(React.Fragment,null,h('p',{className:'dots-note'},node?.relationSource==='content'?`按历史＋时间推断：${node.branchPoint?.sharedMessages} 条共同消息。可在此修正。`:node?.relationSource==='codex-fork'?`来源：forked_from_id 原生分支记录（最高优先级）。父对话 ${node.forkedFromId}。${node.forkedFromOrdinalExclusive!=null?' 分支位置 ordinal exclusive = '+node.forkedFromOrdinalExclusive+'（不是界面消息序号）。':''}`:node?.relationSource==='native'?'来源：原生父节点记录。':'来源可手动指定。'),h('label',null,'父对话',h('select',{value:parentKey,disabled:!!node?.forkedFromId,onChange:e=>setParentKey(e.target.value)},h('option',{value:''},'项目根 · 深度 1'),...(tree?.nodes||[]).filter(n=>!n.mirrorOf&&n.key!==selected).map(n=>h('option',{key:n.key,value:n.key},n.title)))),field('分支原因',intent,setIntent,true),button('保存关系',saveLink,busy),node?.parentKey&&button('DeepSeek 总结（消耗额度）',summarize,busy),node?.reason&&h('p',null,node.reason),node?.reasonError&&h('p',{className:'dots-error'},node.reasonError)),
      tab==='dots'&&h(React.Fragment,null,h('p',null,'DeepSeek 负责计划与推进，执行仍遵守费用确认、权限和额度停止阈值。'),found&&h('div',{className:'dots-run'},h('strong',null,labels[found.status]||found.status),h('div',null,`${found.turns||0}/${found.maxTurns||'—'} 轮 · 停止阈值 ${found.quota?.stopAtLeftPercent??'未设置'}%`),found.reason&&h('div',null,found.reason),h('div',null,worker?.model||'默认模型')),field('目标或控制指令',goal,setGoal,true),button('交给 DeepSeek',submitDots,busy||!owner||!goal.trim()),!owner&&h('p',{className:'dots-note'},'先打开一个 DSH 主对话，再提交目标。'),intent&&h('p',{className:'dots-note'},intent)));
    // 提醒放在独立悬浮层，数量变化不挤压画布，也不重新挂载尺寸监听目标。
    const notices=h('div',{className:'dots-notices',key:'notices'},
      entryHint>0&&h('div',{className:'dots-progress',role:'status'},'再次点击进入对话'),
      serverInfo&&!serverInfo.capabilities.includes('permanent-delete-v1')&&noticeVisible('server-reload')&&h('div',{className:'dots-progress',role:'status'},'前端已更新，DSH 后端尚未重载。请完全退出应用后重开，以启用删除功能。'),
      ...deletionReports.filter(r=>r.status!=='completed'&&noticeVisible('delete:'+r.file+':'+r.status+':'+r.errors.join('；'))).map(r=>h('div',{className:r.status==='error'?'dots-error':'dots-progress',key:r.file,role:'status'},r.status==='error'?'历史清理失败：'+r.errors.join('；'):'DSH 历史待退出后删除；完全退出 DSH，等待清理结果后再启动。',h('div',{className:'dots-note'},r.file))),
      tree?.loading?.running&&project&&h('div',{className:'dots-progress',role:'status'},`${tree.loading.phase} · ${tree.loading.done}/${tree.loading.total} · 复用 ${tree.loading.reused} 项`),
      tree?.loading?.errors?.length>0&&noticeVisible('index:'+project+':'+tree.loading.errors.join('\n'))&&h('div',{className:'dots-error'},tree.loading.errors.join('\n')),
      error&&noticeVisible('error:'+project+':'+error)&&h('div',{className:'dots-error',role:'alert'},error),tree?.copy?.running&&project&&h('div',{className:'dots-progress',role:'status'},`${tree.copy.phase} · ${tree.copy.done}/${tree.copy.total}`)
    );
    return h('section',{className:'dots-orbit','aria-label':'项目对话星图'},
      h('header',{className:'dots-bar'},
        h('input',{className:'dots-search',type:'search',placeholder:'搜索项目…','aria-label':'搜索项目',value:filter,onChange:e=>{const value=e.target.value;captureMotion();overviewScroll.current=0;if(spaceRef.current)spaceRef.current.scrollTop=0;setFilter(value);if(value.trim()&&project){chooseProject('');setPendingOpen('');}}}),
        h('nav',{className:'dots-actions','aria-label':'页面操作'},project&&button('全部项目',()=>chooseProject('')),project&&button('居中',()=>{const el=spaceRef.current;if(el){el.scrollLeft=treeScrollLeft(model,el.clientWidth);el.scrollTop=0;}}),button('刷新',project?refresh:()=>act(()=>discover()),busy),h('button',{className:'dots-chip dots-back',onClick:goBack,disabled:!canClose},'← 返回'))),
      h('div',{className:'dots-legend'},h('span',null,h('i',{className:'dots-dot'}),'Codex 项目'),h('span',null,h('i',{className:'dots-dot dsh'}),'DSH 项目'),project&&h('label',null,h('input',{type:'checkbox',checked:showInternal,onChange:e=>setShowInternal(e.target.checked)}),' 显示后台子代理'),project&&h('label',null,h('input',{type:'checkbox',checked:showUnavailable,onChange:e=>setShowUnavailable(e.target.checked)}),' 显示空白/异常'),h('span',{className:'dots-spacer'}),project?`${currentProject?.title||project} · ${tree?model.nodes.length:'…'} 个对话`:null),
      h('div',{className:'dots-workspace',key:'workspace',ref:workspaceRef,'data-modal-open':drawer?'true':undefined},h('div',{className:'dots-motion-layer',key:'motion-layer',ref:motionLayerRef,'aria-hidden':true}),notices,project&&h('nav',{className:'dots-rail','aria-label':'Codex 项目 左'},...others.filter(p=>projectSide(p)==='codex').map(projectBall)),
        h('div',{className:'dots-space',key:'canvas',ref:spaceRef},!project?h('div',{className:'dots-galaxy',style:{height:scattered.height}},...scattered.projects.map(projectBall),(!projects.length||!matchingProjects.length)&&h('p',{className:'dots-empty'},query?'没有匹配的项目':'正在发现项目…')):h('div',{className:'dots-map',style:{width:model.width,height:model.height}},
          h('svg',{className:'dots-links',width:model.width,height:model.height,'aria-hidden':true},...model.edges.map((edge,i)=>h('g',{key:i},h('path',{d:`M ${edge.from.x} ${edge.from.y+60} C ${edge.from.x} ${edge.from.y+135}, ${edge.to.x} ${edge.to.y-135}, ${edge.to.x} ${edge.to.y-60}`}),edge.to.reason&&h('text',{x:(edge.from.x+edge.to.x)/2,y:(edge.from.y+edge.to.y)/2+12,textAnchor:'middle'},edge.to.reason)))),
          h('div',{className:'dots-node root','data-motion-key':'project:'+project,'data-motion-side':currentProject?projectSide(currentProject):'dsh',style:{left:model.root.x-70,top:model.root.y-70}},h('button',{className:'dots-ball '+(currentProject?.sources.includes('codex')?'codex':'dsh'),title:standalone?'未归入项目的对话':project,onClick:standalone?undefined:()=>rootAction('new')},h('strong',null,currentProject?.title||'项目'),h('small',null,standalone?'未归入项目':'项目根 · 点击新建')), !standalone&&h('div',{className:'dots-satellites'},h('button',{className:'dots-satellite',onClick:()=>rootAction('new')},'新建'),h('button',{className:'dots-satellite',title:'复制项目到 DSH',onClick:()=>rootAction('copy')},'复制'),h('button',{className:'dots-satellite danger',title:'删除项目及对话历史',disabled:busy,onClick:()=>askDelete(null)},'删除'))),
          ...model.nodes.map(n=>h('div',{key:n.key,className:'dots-node'+(selected===n.key?' selected':'')+(n.depth==null?' pending':''),'data-motion-key':'conversation:'+project+':'+n.key,'data-motion-side':n.source,style:{left:n.x-60,top:n.y-60}},h('button',{className:'dots-ball '+n.source,title:n.title,onClick:()=>setEntryHint(v=>v+1),onDoubleClick:()=>{setEntryHint(0);enter(n);},'aria-label':`进入 ${n.title}`,'aria-description':'快速双击进入对话'},h('strong',null,n.title),h('small',null,(n.source==='codex'?'Codex':'DSH')+' · '+(standalone?'独立对话':n.depth==null?'待确认':`深度 ${n.depth}`))),h('div',{className:'dots-satellites'},...(standalone?[['历史','history'],['Dots','dots']]:[['分支','branch'],['历史','history'],['Dots','dots'],['删除','delete']]).map(([label,mode])=>h('button',{key:mode,className:'dots-satellite'+(mode==='delete'?' danger':''),title:label,disabled:busy,onClick:()=>mode==='delete'?askDelete(n):pick(n,mode)},label))),h('div',{className:'dots-node-note'},n.unavailable?'历史不可用':n.empty?'空白会话':n.internal?'后台子代理':n.unresolved?'来源待确认':n.relationSource==='codex-fork'?'原生 fork 分支':n.relationSource==='content'?'历史＋时间推断':n.archived?'已归档':n.dshSessionId?'已复制到 DSH':''))),
          !model.nodes.length&&h('div',{className:'dots-empty',style:{paddingTop:200}},!tree||tree.loading?.running?'正在更新对话目录，可先浏览已加载节点…':standalone?'暂无独立对话。':'此项目暂无普通对话，点击根球新建。'))),
        project&&h('nav',{className:'dots-rail','aria-label':'DSH 项目 右'},...others.filter(p=>projectSide(p)==='dsh').map(projectBall)),
        drawer&&project&&h('div',{className:'dots-modal-layer'+(closing?' closing':''),onClick:e=>{if(e.target===e.currentTarget&&canClose)closeDialog();}},h('aside',{className:'dots-drawer',role:'dialog','aria-modal':true,'aria-label':'对话操作与 Dots',tabIndex:-1,ref:dialogRef,onKeyDown:e=>{if(e.key==='Escape'&&canClose)closeDialog();if(e.key==='Tab'){const items=[...e.currentTarget.querySelectorAll('button:not(:disabled),input,textarea,select,[tabindex="0"]')];const first=items[0],last=items.at(-1);if(e.shiftKey&&(document.activeElement===first||document.activeElement===e.currentTarget)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}}},h('div',{className:'dots-drawer-head'},button('← 返回项目',closeDialog,!canClose),h('strong',null,deletion?.title||node?.title||currentProject?.title),h('button',{className:'dots-close','aria-label':'关闭对话操作',onClick:closeDialog,disabled:!canClose},'×')),node&&tab!=='delete'&&h('div',{className:'dots-tabs'},...(standalone?[['history','历史'],['dots','Dots']]:[['history','历史'],['dots','Dots'],['branch','分支'],['relation','关系']]).map(([mode,label])=>h('button',{className:'dots-chip'+(tab===mode?' active':''),key:mode,onClick:()=>setTab(mode)},label))),
          h('div',{className:'dots-drawer-body'},form,tab==='history'&&h(React.Fragment,null,historyLoading&&h('p',{className:'dots-note'},'正在读取完整历史…'),...display.map((m,i)=>h('article',{className:'dots-message '+m.role,key:m.id||i},h('div',{className:'dots-role'},m.role==='user'?'用户':m.role==='assistant'?node?.source==='codex'?'Codex':'DeepSeek':'工具记录'),h(MarkdownText,{text:m.text||'',streaming:worker?.status==='running',labels:markdownLabels}),h('details',{className:'dots-note'},h('summary',null,'完整原文'),h('pre',{className:'dots-source'},m.text)))),node?.unavailable&&h('p',{className:'dots-error'},'历史不可用：'+node.unavailable),!node?.unavailable&&!historyLoading&&!display.length&&h('p',{className:'dots-note'},'这个对话还没有消息。')))))));
  }
  function apply(ctx) {
    ctx.effect(()=>{const style=document.createElement('style');style.dataset.codexDots='orbital';style.textContent=css;document.head.append(style);return()=>style.remove();});
    const bind=(slot,options,Component)=>ctx.effect(()=>ctx.slots.inject(slot,()=>ctx.slots.register({name:slot,...options},Component)));
    // 统一入口：Dots 位于对话球的操作抽屉，不再注册独立列表或右侧栏。
    bind('sidebar.panellist',{id:ID,label:'项目对话树',order:19},()=>h('span',null,'◌'));
    bind('main',{key:ID},()=>h(OrbitalPage,{ctx}));
  }
  return { apply, mergeTurns, withLive, layoutTree, treeScrollLeft, scatterProjects, projectSize, projectSide, createOrbitalMotion, inject: ['slots','layout','uiSession','uiWorkspace'] };
} });
