import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ConversationTree } from './conversation-tree.mjs';

// DSH 没有删除历史的宿主命令：日志写入进程退出后，由独立 Node 清理精确会话目录。
export async function queueDshDeletion(service, targets, project) {
  const directory = path.join(service.cacheDir, 'deletions');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, randomUUID() + '.json');
  await fs.writeFile(file, JSON.stringify({ status: 'pending', parentPid: process.pid, project,
    root: service.ctx.sessionPersistence.config.root, targets,
    searchIndex: service.ctx.sessionQuery.config?.path, createdAt: Date.now() }, null, 2));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/delete-dsh-history.mjs', import.meta.url)), file], {
    detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  try { await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); }
  catch (e) {
    const job = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...job, status: 'error', errors: [e.message] }, null, 2));
    throw e;
  }
  child.unref();
  return file;
}

export class ConversationDeletion {
  constructor(service, engine, { queue = queueDshDeletion } = {}) {
    this.service = service; this.engine = engine; this.queue = queue; this.plans = new Map();
  }
  async prepare({ project, key }) {
    const service = this.service, store = new ConversationTree(project);
    if (service.copies.get(path.resolve(project))?.progress.running) throw Error('项目正在复制，请等待复制完成再删除');
    // 项目级删除先取得完整目录，不根据屏幕上过滤后的数量删除。
    if (!key) {
      const indexed = await service.sync(project, true);
      if (indexed.indexErrors?.length) throw Error('项目目录尚未完整读取，请先解决索引错误后删除项目');
    }
    const tree = await store.read(), node = tree.nodes.find(n => n.key === key);
    if (key && !node) throw Error('对话已不存在，请刷新');
    const nodes = tree.nodes.filter(n => !tree.deletedKeys?.includes(n.key) && (!key || n.key === key || n.mirrorOf === key || n.id === node?.dshSessionId));
    if (node?.dshSessionId && !nodes.some(n => n.id === node.dshSessionId)) nodes.push({ key: 'dsh:' + node.dshSessionId, id: node.dshSessionId, source: 'dsh' });
    this.assertIdle(nodes);
    const dsh = [];
    for (const n of nodes.filter(n => n.source === 'dsh')) {
      const stat = await service.ctx.sessionPersistence.stat(n.id);
      if (!stat) continue;
      if (!stat.location?.path || !service.ctx.sessionPersistence.config?.root || stat.header.id !== n.id) throw Error('当前 DSH 存储不支持精确删除此历史：' + n.id);
      // 只允许宿主标识的 session 日志目录；永远不把 cwd 当作删除路径。
      const root = await fs.realpath(service.ctx.sessionPersistence.config.root), dir = await fs.realpath(path.dirname(stat.location.path));
      const parts = path.relative(root, dir).split(path.sep);
      if (parts.length !== 2 || parts.includes('..') || path.basename(dir) !== n.id) throw Error('不是 DSH 专用会话目录：' + n.id);
      dsh.push({ id: n.id, dir });
    }
    const plan = { token: randomUUID(), project: path.resolve(project), key, nodes, dsh, confirmed: false,
      title: node?.title || path.basename(project), scope: key ? 'conversation' : 'project', codexCount: nodes.filter(n => n.source === 'codex').length, dshCount: dsh.length };
    this.plans.set(plan.token, plan);
    return { token: plan.token, title: plan.title, scope: plan.scope, codexCount: plan.codexCount, dshCount: plan.dshCount };
  }
  assertIdle(nodes) {
    for (const run of this.engine.runs.values()) if (!['completed', 'cancelled'].includes(run.status) && run.workers.some(w => nodes.some(n => n.id === w.threadId || n.id === w.childId))) throw Error('对话仍由 Dots 代管，请先结束代管任务再删除');
    for (const n of nodes) if (n.source === 'dsh') {
      const agent = this.service.ctx.agents.get(n.id);
      if (agent && agent.status !== 'idle') throw Error('对话仍在执行，请先停止：' + n.id);
    }
  }
  async confirm({ token, step }) {
    const plan = this.plans.get(token);
    if (!plan) throw Error('删除确认已失效，请重新选择');
    if (step === 1) { plan.confirmed = true; return { confirmed: true }; }
    if (step !== 2 || !plan.confirmed) throw Error('需要先完成第一次范围确认');
    this.assertIdle(plan.nodes);
    this.plans.delete(token); // 第二次确认只执行一次，双击不重复删除。
    const service = this.service, errors = [], removed = [], codex = plan.nodes.filter(n => n.source === 'codex');
    for (const n of codex) {
      try { await (await service.codex()).call('thread/delete', { threadId: n.id }); removed.push(n.key); }
      catch (e) { errors.push(n.title + '：' + e.message); }
    }
    let receipt;
    if (!errors.length && plan.dsh.length) {
      try {
        // 归档是等待退出期间的执行闸门，完成状态仍明确显示为待删除。
        for (const n of plan.dsh) await service.ctx.workspaceRegistry.archiveSession(n.id);
        receipt = await this.queue(service, plan.dsh, plan.project);
        removed.push(...plan.nodes.filter(n => n.source === 'dsh').map(n => n.key));
      } catch (e) { errors.push('DSH 删除安排失败：' + e.message); }
    }
    if (!plan.dsh.length) removed.push(...plan.nodes.filter(n => n.source === 'dsh').map(n => n.key));
    if (plan.scope === 'project' && !errors.length) {
      try { for (const w of service.ctx.workspaceRegistry.list()) if (path.resolve(w.path).toLowerCase() === plan.project.toLowerCase()) await service.ctx.workspaceRegistry.delete(w.id); }
      catch (e) { errors.push('移除工作区失败：' + e.message); }
    }
    const tree = await new ConversationTree(plan.project).change(t => {
      t.deletedKeys = [...new Set([...(t.deletedKeys || []), ...removed])];
      t.nodes = t.nodes.filter(n => !removed.includes(n.key));
      // 保留后代的真实来源 ID；父节点删除后显示来源缺失，不伪造新父子方向。
      if (plan.scope === 'project' && !errors.length) t.deletedProject = true;
      if (receipt) t.deletionReceipt = receipt;
    });
    if (service.projectList) {
      if (tree.deletedProject) service.projectList.projects = service.projectList.projects.filter(p => path.resolve(p.path) !== plan.project);
      else for (const p of service.projectList.projects) if (path.resolve(p.path) === plan.project) p.count = tree.nodes.filter(n => !n.mirrorOf && !n.internal && !n.hiddenReason && !n.unavailable && !n.empty).length;
      await service.saveProjects();
    }
    service.queue = service.queue.filter(p => path.resolve(p) !== plan.project);
    return { removed, errors, receipt, message: errors.length ? '部分操作未完成，请查看错误。' : receipt ? 'Codex 删除已完成；DSH 历史待完全退出应用后永久删除。清理结果记录在下方文件。' : '删除已完成；项目代码和文件已保留。' };
  }
}
