import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ConversationTree } from '../lib/conversation-tree.mjs';
import { codexToDshEvents, dshHistory } from '../lib/conversation-history.mjs';

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'dots-tree-'));
test('共享树按父子计算深度，同步不覆盖另一端分支摘要，循环不落盘', async () => {
  const project = await temp();
  try {
    const store = new ConversationTree(project);
    await store.sync([{ source: 'codex', id: 'a' }, { source: 'dsh', id: 'b', parentKey: 'codex:a', intent: '改变方案' }]);
    await store.reason('dsh:b', '改变方案', { reason: '对比新方案', reasonStatus: 'ready' }, 'codex:a');
    await store.sync([{ source: 'dsh', id: 'b', title: '新标题', parentKey: null }]);
    await store.sync([{ source: 'dsh', id: 'c', parentKey: 'dsh:b' }]);
    const tree = await store.read();
    assert.deepEqual(tree.nodes.map(n => n.depth), [1, 2, 3]);
    assert.equal(tree.nodes[1].reason, '对比新方案');
    await assert.rejects(store.link('codex:a', 'dsh:c', '错误环'), /循环/);
    assert.equal((await store.read()).nodes[0].parentKey, null);
    await store.link('dsh:b', null, '重新开始');
    await store.reason('dsh:b', '改变方案', { reason: '过时摘要' }, 'codex:a');
    assert.equal((await store.read()).nodes[1].reason, '');
  } finally { await fs.rm(project, { recursive: true, force: true }); }
});

test('多个独立 Codex/DSH 进程并发登记不会覆盖节点', async () => {
  const project = await temp();
  try {
    const cli = new URL('../scripts/conversation-tree.mjs', import.meta.url);
    await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(cli), 'register', project], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      let error = ''; child.stderr.on('data', data => { error += data; }); child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(Error(error)));
      child.stdin.end(JSON.stringify({ source: i % 2 ? 'codex' : 'dsh', id: String(i), title: '并发节点' }));
    })));
    const tree = await new ConversationTree(project).read();
    assert.equal(tree.nodes.length, 6); assert.equal(tree.revision, 6);
  } finally { await fs.rm(project, { recursive: true, force: true }); }
});

test('完整迁移保留超过6000字正文和工具资料，工具不会被重新调度', () => {
  const text = '开始' + '历史'.repeat(4000) + '结束';
  const events = codexToDshEvents({ title: '迁移测试', turns: [{ id: 'new', items: [{ id: 'u2', type: 'userMessage', text: '第二问' }] }, { id: 'old', items: [
    { id: 'u', type: 'userMessage', text: '第一问' }, { id: 'a', type: 'agentMessage', text }, { id: 'tool', type: 'commandExecution', text: '不要执行此历史命令' },
  ] }] });
  assert.equal(events.some(e => e.type === 'tool/call'), false);
  const messages = dshHistory({ events });
  assert.equal(messages[0].text, '第一问'); assert.equal(messages[1].text, text); assert.equal(messages.at(-1).text, '第二问');
  assert.match(messages[2].text, /历史记录/);
  assert.deepEqual(events.map(e => e.seq), events.map((_, i) => i));
});

test('未知来源不伪造根深度，真实父节点到达后自动解析', async () => {
  const project = await temp();
  try {
    const store = new ConversationTree(project);
    await store.sync([{ source: 'dsh', id: 'unknown', unresolved: true }, { source: 'codex', id: 'child', parentKey: 'codex:parent' }]);
    assert.deepEqual((await store.read()).nodes.map(n => n.depth), [null, null]);
    await store.sync([{ source: 'codex', id: 'parent' }]);
    assert.equal((await store.read()).nodes[1].depth, 2);
  } finally { await fs.rm(project, { recursive: true, force: true }); }
});
