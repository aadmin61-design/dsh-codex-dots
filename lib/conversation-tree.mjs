import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const nodeKey = (source, id) => `${source}:${id}`;
export const treePath = project => path.join(project, '.dsh-codex-dots', 'tree.json');

// 两端读写同一项目文件；短时写锁避免 CLI 和 DSH 相互覆盖，临时文件保证读者看到完整 JSON。
export class ConversationTree {
  constructor(project) { this.project = path.resolve(project); this.file = treePath(this.project); }
  async read() {
    let tree;
    try { tree = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; tree = { version: 1, project: this.project, revision: 0, autoSummaries: false, nodes: [] }; }
    return projectDepths(tree);
  }
  async change(edit) {
    if (!(await fs.stat(this.project)).isDirectory()) throw Error('项目根必须是已有文件夹');
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const lock = this.file + '.lock'; let handle;
    for (let attempt = 0; ; attempt++) {
      try { handle = await fs.open(lock, 'wx'); break; }
      catch (error) { if (error.code !== 'EEXIST' || attempt >= 50) throw Error('对话树正在被另一端更新，请稍后重试'); await new Promise(r => setTimeout(r, 100)); }
    }
    try {
      const tree = await this.read();
      await edit(tree);
      projectDepths(tree); // 拒绝循环，深度由父子关系计算，调用者不能直接改深度。
      tree.revision++; tree.updatedAt = Date.now();
      const temp = this.file + '.' + randomUUID() + '.tmp';
      await fs.writeFile(temp, JSON.stringify(tree, null, 2) + '\n');
      await fs.rename(temp, this.file);
      return tree;
    } finally { await handle.close(); await fs.unlink(lock); }
  }
  async sync(rows) {
    return this.change(tree => {
      for (const row of rows) {
        const key = nodeKey(row.source, row.id), existing = tree.nodes.find(n => n.key === key);
        if (existing) {
          // 发现过程只刷新标题与活动状态，绝不覆盖用户/另一端维护的分支关系和摘要。
          Object.assign(existing, { title: row.title || existing.title, updatedAt: row.updatedAt, archived: row.archived ?? false });
          if (existing.unresolved && row.parentKey) { existing.parentKey = row.parentKey; existing.unresolved = false; existing.reasonStatus = 'pending'; }
        } else tree.nodes.push({ key, source: row.source, id: row.id, title: row.title || row.id,
          parentKey: row.parentKey ?? null, unresolved: row.unresolved ?? false,
          reason: '', reasonStatus: row.parentKey ? 'pending' : 'none', intent: row.intent || '', createdAt: Date.now(), ...row, key });
      }
    });
  }
  async link(key, parentKey, intent) {
    return this.change(tree => {
      const node = tree.nodes.find(n => n.key === key);
      if (!node) throw Error('未找到对话节点');
      if (parentKey && !tree.nodes.some(n => n.key === parentKey)) throw Error('父对话必须位于同一项目树');
      Object.assign(node, { parentKey: parentKey || null, unresolved: false, intent: intent || '',
        reason: '', reasonStatus: parentKey ? 'pending' : 'none', reasonError: null });
    });
  }
  async reason(key, intent, result, parentKey) {
    return this.change(tree => {
      const node = tree.nodes.find(n => n.key === key);
      if (!node || node.intent !== intent || (parentKey !== undefined && node.parentKey !== parentKey)) return; // 摘要期间改了来源/目标时不覆盖。
      Object.assign(node, result);
    });
  }
}

export function projectDepths(tree) {
  const byKey = new Map(tree.nodes.map(n => [n.key, n])), visiting = new Set(), done = new Set();
  const visit = node => {
    if (done.has(node.key)) return node.depth;
    if (visiting.has(node.key)) throw Error('分支关系形成循环');
    visiting.add(node.key);
    const parent = node.parentKey && byKey.get(node.parentKey);
    node.depth = node.unresolved || (node.parentKey && !parent) ? null : parent ? (visit(parent) == null ? null : parent.depth + 1) : 1;
    visiting.delete(node.key); done.add(node.key); return node.depth;
  };
  for (const node of tree.nodes) visit(node);
  return tree;
}
