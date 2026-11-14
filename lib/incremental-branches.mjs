import { inferBranches } from './branch-inference.mjs';

export async function mapConcurrent(items, limit, fn) {
  let index = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) { const i = index++; await fn(items[i], i); }
  }));
  const failed = results.find(r => r.status === 'rejected'); if (failed) throw failed.reason;
}

// 按需读取共同前缀；并发比较共享同一个读取器，避免同一页重复加载。
class PrefixReader {
  constructor(node, open, gate) { this.node = node; this.open = open; this.gate = gate; this.messages = []; this.done = false; }
  async at(index) {
    while (this.messages.length <= index && !this.done) {
      if (this.error) throw this.error;
      this.loading ??= this.gate(async () => {
        this.source ??= await this.open(this.node);
        const page = await this.source.next();
        this.messages.push(...page.messages.map(m => ({ ...m, text: (m.text || '').replace(/\r\n/g, '\n').trim() })));
        this.done = page.done;
      }).catch(e => { this.error = e; throw e; }).finally(() => { this.loading = null; });
      await this.loading;
    }
    return this.messages[index];
  }
  async close() { await this.source?.close?.(); }
}

// 复用已有父节点选择规则：最长共同前缀优先，同分时按源对话创建时间决定。
export async function compareBranches(nodes, open, cache, { signal, progress = () => {}, yieldWork = async () => {} } = {}) {
  const readers = new Map(), results = new Map(), failures = new Map();
  let active = 0; const waiting = [];
  const gate = async fn => {
    if (active >= 4) await new Promise(resolve => waiting.push(resolve));
    active++;
    try { signal?.throwIfAborted(); await yieldWork(); return await fn(); }
    finally { active--; waiting.shift()?.(); }
  };
  const reader = n => { if (!readers.has(n.key)) readers.set(n.key, new PrefixReader(n, open, gate)); return readers.get(n.key); };
  const candidates = nodes.filter(n => !n.mirrorOf && !n.hiddenReason && !n.unavailable);
  const byKey = new Map(nodes.map(n => [n.key, n]));
  const pairs = [];
  for (const child of candidates) {
    if (child.relationSource === 'manual' || (child.parentKey && child.relationSource !== 'content')) continue;
    for (const parent of candidates) {
      if (parent.key === child.key || parent.source !== child.source) continue;
      // 已知后代不能反过来成为祖先候选，即使缺少创建时间也不读正文猜方向。
      let ancestor = parent;
      while (ancestor?.parentKey && ancestor.parentKey !== child.key) ancestor = byKey.get(ancestor.parentKey);
      if (ancestor?.parentKey === child.key) continue;
      if (parent.sourceCreatedAt && child.sourceCreatedAt && parent.sourceCreatedAt >= child.sourceCreatedAt) continue;
      pairs.push({ child, parent, key: JSON.stringify([child.key, parent.key]) });
    }
  }
  let done = 0, reused = 0;
  const scores = new Map();
  try {
    await mapConcurrent(pairs, 4, async ({ child, parent, key }) => {
      signal?.throwIfAborted();
      const stamps = [child.historyStamp, parent.historyStamp], old = cache[key];
      try {
        let score;
        if (stamps.every(Boolean) && old && JSON.stringify(stamps) === JSON.stringify(old.stamps)) { score = old.score; reused++; }
        else {
          const a = reader(parent), b = reader(child); let count = 0, chars = 0, ids = 0, nextMessageId = null;
          while (true) {
            const [x, y] = await Promise.all([a.at(count), b.at(count)]);
            nextMessageId = y?.id || null;
            if (!x || !y || x.role !== y.role || x.text !== y.text) break;
            chars += x.text.length; if (x.id && x.id === y.id) ids++; count++;
          }
          score = { count, chars, ids, nextMessageId };
          cache[key] = { stamps, score };
        }
        scores.set(key, score);
      } catch (e) {
        if (signal?.aborted) throw e;
        for (const n of [child, parent]) if (readers.get(n.key)?.error) failures.set(n.key, readers.get(n.key).error.message);
      }
      progress({ done: ++done, total: pairs.length, reused });
    });
    // 仅将已完成比较的计数交给选择逻辑，不把截断页当成完整历史。
    const patches = inferBranches(nodes.map(n => n.relationSource === 'content' ? { ...n, parentKey: null } : n), new Map(), scores);
    for (const patch of patches) if (!failures.has(patch.key)) results.set(patch.key, patch);
    return { patches: [...results.values()], failures: Object.fromEntries(failures), reused, comparisons: done };
  } finally { await Promise.allSettled([...readers.values()].map(r => r.close())); }
}
