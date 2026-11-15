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
        const key = nodeKey(row.source, row.id);
        if (tree.deletedKeys?.includes(key)) continue; // 永久删除已提交，后台目录扫描不能复活节点。
        const existing = tree.nodes.find(n => n.key === key);
        if (existing) {
          // 明确 fork 记录优先，其余发现过程保留用户维护的关系。
          Object.assign(existing, { title: row.title || existing.title, updatedAt: row.updatedAt, archived: row.archived ?? false });
          for (const field of ['internal', 'hiddenReason', 'unavailable', 'historyStamp', 'empty']) if (field in row) existing[field] = row[field];
          if (row.sourceCreatedAt) existing.sourceCreatedAt = row.sourceCreatedAt;
          if ('delegationParentId' in row) existing.delegationParentId = row.delegationParentId;
          if (row.source === 'codex' && row.lineageChecked && !row.forkedFromId && !existing.forkedFromId && existing.relationSource === 'native') {
            // 升级清理旧版本把 parentThreadId 当作手动分支的结果。
            Object.assign(existing, { parentKey: null, relationSource: null, reason: '', reasonStatus: 'none', unresolved: false });
          }
          if (row.unresolved && !existing.parentKey && existing.relationSource !== 'manual') existing.unresolved = true;
          // 原生来源优先于内容推断，但保留用户明确修订的关系。
          if (!row.forkedFromId && row.parentKey && existing.relationSource !== 'manual' && (!existing.parentKey || existing.relationSource === 'content')) {
            Object.assign(existing, { parentKey: row.parentKey, unresolved: false, relationSource: 'native', reasonStatus: 'pending' });
          }
        } else tree.nodes.push({ key, source: row.source, id: row.id, title: row.title || row.id,
          parentKey: row.parentKey ?? null, unresolved: row.unresolved ?? false,
          reason: '', relationSource: row.parentKey ? 'native' : null, reasonStatus: row.parentKey ? 'pending' : 'none', intent: row.intent || '', createdAt: Date.now(), ...row, key });
        const node = tree.nodes.find(n => n.key === key);
        if (row.source === 'codex' && row.forkedFromId) {
          const parentKey = nodeKey('codex', row.forkedFromId), changed = node.parentKey !== parentKey;
          Object.assign(node, { parentKey, forkedFromId: row.forkedFromId,
            forkedFromOrdinalExclusive: row.forkedFromOrdinalExclusive ?? node.forkedFromOrdinalExclusive ?? null,
            relationSource: 'codex-fork', unresolved: false });
          delete node.branchPoint; delete node.branchCandidates;
          if (changed) Object.assign(node, { reason: '', reasonStatus: 'pending', reasonError: null });
        }
      }
      // 旧推断/手动反向连线可能与刚补录的 fork 形成环，撤掉冲突的低优先级边。
      const byKey = new Map(tree.nodes.map(n => [n.key, n]));
      for (const fork of tree.nodes.filter(n => n.forkedFromId)) {
        const chain = [], seen = new Set(); let current = fork;
        while (current && !seen.has(current.key)) { seen.add(current.key); chain.push(current); current = byKey.get(current.parentKey); }
        if (current?.key === fork.key) {
          const weak = chain.find(n => !n.forkedFromId);
          if (weak) Object.assign(weak, { parentKey: null, relationSource: null, unresolved: true, reason: '', reasonStatus: 'none' });
        }
      }
    });
  }
  async link(key, parentKey, intent) {
    return this.change(tree => {
      const node = tree.nodes.find(n => n.key === key);
      if (!node) throw Error('未找到对话节点');
      if (node.forkedFromId && parentKey !== nodeKey('codex', node.forkedFromId)) throw Error('此对话已有 forked_from_id 原生分支记录，父节点以该记录为准');
      if (parentKey && !tree.nodes.some(n => n.key === parentKey)) throw Error('父对话必须位于同一项目树');
      Object.assign(node, { parentKey: parentKey || null, unresolved: false, relationSource: node.forkedFromId ? 'codex-fork' : 'manual', intent: intent || '',
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
    const mirror = node.mirrorOf && byKey.get(node.mirrorOf);
    const parent = node.parentKey && byKey.get(node.parentKey);
    if (mirror) { node.depth = visit(mirror); visiting.delete(node.key); done.add(node.key); return node.depth; }
    node.depth = node.unresolved || (node.parentKey && !parent) ? null : parent ? (visit(parent) == null ? null : parent.depth + 1) : 1;
    visiting.delete(node.key); done.add(node.key); return node.depth;
  };
  for (const node of tree.nodes) visit(node);
  return tree;
}

// 独立对话是逻辑分组，没有项目目录。
export const STANDALONE = 'standalone-conversations';
export const standaloneGroups = { codex: STANDALONE + ':codex', dsh: STANDALONE + ':dsh' };
export const isStandaloneGroup = key => key === STANDALONE || Object.values(standaloneGroups).includes(key);
