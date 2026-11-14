import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ConversationTree } from '../lib/conversation-tree.mjs';
import { ConversationDeletion } from '../lib/conversation-delete.mjs';
import { eraseDshHistory, runDeletion } from '../scripts/delete-dsh-history.mjs';

// 所有删除都指向临时夹具，不连接用户的 Codex 或 DSH 会话。
async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dots-delete-'));
  const project = path.join(base, 'project'), root = path.join(base, 'sessions');
  await fs.mkdir(project); await fs.writeFile(path.join(project, 'code.py'), '保留代码');
  const calls = [], files = new Map();
  for (const id of ['copy', 'child']) {
    const dir = path.join(root, '--project--', id); await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'session.v4.jsonl.zstd'); await fs.writeFile(file, '历史'); files.set(id, file);
  }
  const store = new ConversationTree(project);
  await store.sync([{ source: 'codex', id: 'cx', title: '原对话', dshSessionId: 'copy' },
    { source: 'dsh', id: 'copy', mirrorOf: 'codex:cx' }, { source: 'dsh', id: 'child', parentKey: 'codex:cx' }]);
  const workspace = { id: 'w', path: project };
  const service = { ctx: { agents: { get: () => undefined },
    sessionPersistence: { config: { root }, stat: async id => files.has(id) ? { header: { id }, location: { path: files.get(id) } } : null },
    workspaceRegistry: { list: () => [workspace], archiveSession: async id => calls.push(['archive', id]), delete: async id => calls.push(['workspace', id]) } },
    copies: new Map(), queue: [project], projectList: { projects: [workspace] }, saveProjects: async () => {},
    sync: async () => store.read(), codex: async () => ({ call: async (method, args) => calls.push([method, args.threadId]) }) };
  const engine = { runs: new Map() };
  const deletion = new ConversationDeletion(service, engine, { queue: async (_s, targets) => { calls.push(['queue', targets]); return 'receipt.json'; } });
  return { base, project, root, store, service, engine, deletion, calls, files, close: () => fs.rm(base, { recursive: true, force: true }) };
}

test('两次确认之后才删除，单对话包含迁移副本但保留子分支，刷新不复活', async () => {
  const f = await fixture();
  try {
    const plan = await f.deletion.prepare({ project: f.project, key: 'codex:cx' });
    assert.equal(plan.codexCount, 1); assert.equal(plan.dshCount, 1);
    await assert.rejects(f.deletion.confirm({ token: plan.token, step: 2 }), /第一次/);
    await f.deletion.confirm({ token: plan.token, step: 1 }); assert.equal(f.calls.length, 0);
    const result = await f.deletion.confirm({ token: plan.token, step: 2 });
    assert.deepEqual(result.errors, []); assert.match(result.message, /待完全退出/);
    assert.deepEqual(f.calls.slice(0, 2), [['thread/delete', 'cx'], ['archive', 'copy']]);
    assert.equal(f.calls.some(c => c[0] === 'workspace'), false);
    let tree = await f.store.read(); assert.deepEqual(tree.nodes.map(n => n.id), ['child']);
    tree = await f.store.sync([{ source: 'codex', id: 'cx' }, { source: 'dsh', id: 'copy' }]);
    assert.deepEqual(tree.nodes.map(n => n.id), ['child']);
    await assert.rejects(f.deletion.confirm({ token: plan.token, step: 2 }), /失效/);
    assert.equal(await fs.readFile(path.join(f.project, 'code.py'), 'utf8'), '保留代码');
  } finally { await f.close(); }
});

test('删除项目调用原生工作区接口，覆盖后台记录；代管中拒绝删除', async () => {
  const f = await fixture();
  try {
    f.engine.runs.set('r', { status: 'paused', workers: [{ threadId: 'cx' }] });
    await assert.rejects(f.deletion.prepare({ project: f.project }), /代管/);
    f.engine.runs.clear();
    const plan = await f.deletion.prepare({ project: f.project });
    assert.equal(plan.dshCount, 2);
    await f.deletion.confirm({ token: plan.token, step: 1 });
    await f.deletion.confirm({ token: plan.token, step: 2 });
    assert.ok(f.calls.some(c => c[0] === 'workspace' && c[1] === 'w'));
    assert.equal((await f.store.read()).deletedProject, true);
    assert.equal(f.service.projectList.projects.length, 0);
  } finally { await f.close(); }
});

test('Codex 删除失败不会删 DSH 副本或移除项目，并明确报告错误', async () => {
  const f = await fixture();
  try {
    f.service.codex = async () => ({ call: async () => { throw Error('会话正在执行'); } });
    const plan = await f.deletion.prepare({ project: f.project });
    await f.deletion.confirm({ token: plan.token, step: 1 });
    const result = await f.deletion.confirm({ token: plan.token, step: 2 });
    assert.match(result.errors[0], /会话正在执行/); assert.equal(f.calls.length, 0);
    assert.equal((await f.store.read()).nodes.length, 3);
  } finally { await f.close(); }
});

test('退出后只清理精确会话及迁移快照，拒绝项目目录；其它历史和代码保留', async () => {
  const f = await fixture();
  try {
    const archive = path.join(f.project, '.dsh-codex-dots', 'history'); await fs.mkdir(archive);
    await fs.writeFile(path.join(archive, 'copy.json'), '迁移原文');
    const result = await eraseDshHistory({ root: f.root, project: f.project, targets: [
      { id: 'copy', dir: path.dirname(f.files.get('copy')) }, { id: 'project', dir: f.project },
    ] });
    assert.deepEqual(result.removed, ['copy']); assert.equal(result.errors.length, 1);
    await assert.rejects(fs.access(f.files.get('copy'))); await assert.rejects(fs.access(path.join(archive, 'copy.json')));
    await fs.access(f.files.get('child')); await fs.access(path.join(f.project, 'code.py'));
  } finally { await f.close(); }
});

test('清理任务在写入进程退出前不删除，退出后完成并落盘结果', async () => {
  const f = await fixture();
  const writer = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  await once(writer, 'spawn');
  let task;
  try {
    const file = path.join(f.base, 'receipt.json');
    await fs.writeFile(file, JSON.stringify({ status: 'pending', parentPid: writer.pid, root: f.root, project: f.project,
      targets: [{ id: 'copy', dir: path.dirname(f.files.get('copy')) }] }));
    task = runDeletion(file);
    await new Promise(resolve => setTimeout(resolve, 80));
    await fs.access(f.files.get('copy'));
    assert.equal(JSON.parse(await fs.readFile(file)).status, 'pending');
    writer.stdin.end(); await task;
    assert.equal(JSON.parse(await fs.readFile(file)).status, 'completed');
    await assert.rejects(fs.access(f.files.get('copy')));
    await fs.access(f.files.get('child')); await fs.access(path.join(f.project, 'code.py'));
  } finally { writer.kill(); await task?.catch(()=>{}); await f.close(); }
});
