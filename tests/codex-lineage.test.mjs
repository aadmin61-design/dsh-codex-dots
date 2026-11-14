import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { zstdCompressSync } from 'node:zlib';
import { CodexLineageReader } from '../lib/codex-lineage.mjs';
import { threadSummary } from '../lib/codex.mjs';
import { ConversationTree } from '../lib/conversation-tree.mjs';
import { compareBranches } from '../lib/incremental-branches.mjs';

test('fork 与委派字段分离，不能从 parentThreadId 生成直接分支', () => {
  const worker = threadSummary({ id:'worker',parentThreadId:'boss' });
  assert.equal(worker.parentId,null); assert.equal(worker.delegationParentId,'boss'); assert.equal(worker.internal,true);
  const fork = threadSummary({ id:'child',forkedFromId:'source',parentThreadId:'boss',forkedFromOrdinalExclusive:123 });
  assert.equal(fork.parentId,'source'); assert.equal(fork.forkedFromOrdinalExclusive,123);
});

test('只读取首行元数据，支持压缩日志、文件名含多个 ID 和并发目录发现', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(),'dots-lineage-'));
  try {
    await fs.mkdir(path.join(home,'sessions','nested'),{recursive:true});await fs.mkdir(path.join(home,'archived_sessions'));
    const header = id => JSON.stringify({type:'session_meta',payload:{id,forked_from_id:'source',forked_from_ordinal_exclusive:6794,parent_thread_id:null}})+'\n';
    const plain = path.join(home,'sessions','nested','rollout-child_other.jsonl');
    await fs.writeFile(plain, header('child')+'后面故意不是JSON，不能解析正文\n');
    await fs.writeFile(path.join(home,'archived_sessions','rollout-source.jsonl.zst'),zstdCompressSync(Buffer.from(header('source')+'不读取正文\n')));
    const reader = new CodexLineageReader(home);
    const [a,b,c] = await Promise.all([reader.read('child'),reader.read('source'),reader.read('other')]);
    assert.equal(a.forked_from_id,'source');assert.equal(a.forked_from_ordinal_exclusive,6794);
    assert.equal(b.id,'source');assert.equal(c,null);
    assert.equal((await reader.read('child',plain)).id,'child');
  } finally { await fs.rm(home,{recursive:true,force:true}); }
});

test('明确 fork 覆盖手动和推断关系，两边更新时间变化不改变方向；同源分支保持兄弟', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(),'dots-fork-priority-'));
  try {
    const store = new ConversationTree(project);
    await store.sync(['root','a','b','wrong'].map(id=>({source:'codex',id})));
    await store.link('codex:a','codex:wrong','旧关系');
    await store.change(t=>Object.assign(t.nodes.find(n=>n.id==='b'),{parentKey:'codex:a',relationSource:'content',branchPoint:{sharedMessages:12},reason:'旧摘要'}));
    const rows = ['a','b'].map(id=>({source:'codex',id,parentKey:'codex:root',forkedFromId:'root',forkedFromOrdinalExclusive:6794,lineageChecked:true,updatedAt:id==='a'?500:1}));
    let tree = await store.sync(rows);
    for(const n of tree.nodes.filter(n=>['a','b'].includes(n.id))) { assert.equal(n.parentKey,'codex:root');assert.equal(n.depth,2);assert.equal(n.relationSource,'codex-fork');assert.equal(n.branchPoint,undefined); }
    assert.equal(tree.nodes.find(n=>n.id==='b').reason,'');
    tree = await store.sync(rows.map(r=>({...r,updatedAt:r.id==='b'?900:2})));
    assert.equal(tree.nodes.find(n=>n.id==='a').parentKey,'codex:root');
    await assert.rejects(store.link('codex:a','codex:b','错误修改'),/forked_from_id/);
    await store.link('codex:a','codex:root','补充分支原因');
    const result = await compareBranches(tree.nodes.filter(n=>n.id!=='wrong'),async()=>{throw Error('原生分支不应读取正文');},{});
    assert.equal(result.comparisons,0);
  } finally { await fs.rm(project,{recursive:true,force:true}); }
});

test('旧 parentThreadId 误建的原生分支清除，保留委派来源', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(),'dots-delegation-'));
  try {
    const store = new ConversationTree(project);
    await store.sync([{source:'codex',id:'parent'},{source:'codex',id:'worker',parentKey:'codex:parent'}]);
    const tree = await store.sync([{source:'codex',id:'worker',lineageChecked:true,forkedFromId:null,delegationParentId:'parent',internal:true}]);
    const worker=tree.nodes.find(n=>n.id==='worker');
    assert.equal(worker.parentKey,null);assert.equal(worker.delegationParentId,'parent');assert.equal(worker.internal,true);
  } finally { await fs.rm(project,{recursive:true,force:true}); }
});

test('原生 fork 补录后撤销旧反向弱关系，避免整棵树因循环拒绝更新', async () => {
  const project=await fs.mkdtemp(path.join(os.tmpdir(),'dots-fork-cycle-'));
  try {
    const store=new ConversationTree(project);
    await store.sync([{source:'codex',id:'parent'},{source:'codex',id:'child'}]);
    await store.link('codex:parent','codex:child','旧反向连线');
    const tree=await store.sync([{source:'codex',id:'child',forkedFromId:'parent'}]);
    assert.equal(tree.nodes.find(n=>n.id==='child').parentKey,'codex:parent');
    assert.equal(tree.nodes.find(n=>n.id==='parent').parentKey,null);
  } finally { await fs.rm(project,{recursive:true,force:true}); }
});
