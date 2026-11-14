import test from 'node:test';
import assert from 'node:assert/strict';
import { compareBranches } from '../lib/incremental-branches.mjs';

const node = (id, time, extra = {}) => ({ key: 'codex:' + id, id, source: 'codex', sourceCreatedAt: time, historyStamp: 'v1', ...extra });
const shared = [{ id: 'u', role: 'user', text: '请分析这个项目'.repeat(10) }, { id: 'a', role: 'assistant', text: '共同的回答'.repeat(10) }];
test('并行从头比较，分叉后不再读取大段尾部；缓存跨运行复用并按变更失效', async () => {
  const nodes = [node('a', 1), node('b', 2), node('c', 3)], cache = {};
  let pages = 0, active = 0, max = 0, closed = 0;
  const open = async n => { let page = 0; return {
    next: async () => { active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 2)); active--; pages++;
      if (page++ === 0) return { messages: shared, done: false };
      if (page === 2) return { messages: [{ id: n.id, role: 'user', text: n.id }], done: false };
      throw Error('不应该读取分叉之后的尾部'); }, close: async () => { closed++; },
  }; };
  const result = await compareBranches(nodes, open, cache);
  assert.equal(pages, 6); assert.ok(max >= 2 && max <= 4); assert.equal(closed, 3);
  assert.equal(result.patches.find(p => p.key === 'codex:c').parentKey, 'codex:b');
  const persisted = JSON.parse(JSON.stringify(cache));
  const repeated = await compareBranches(nodes, () => { throw Error('未变化不能重读'); }, persisted);
  assert.equal(repeated.reused, 3); assert.deepEqual(repeated.patches, result.patches);
  nodes[2].historyStamp = 'v2'; pages = 0;
  const changed = await compareBranches(nodes, open, persisted);
  assert.equal(changed.reused, 1); assert.equal(changed.comparisons, 3); assert.equal(pages, 6);
});
test('原生父节点不做全量比较；单条损坏隔离，其它分支继续', async () => {
  const nodes = [node('a', 1), node('b', 2, { parentKey: 'codex:a', relationSource: 'native' }), node('bad', 3), node('c', 4)];
  const seen = new Map();
  const result = await compareBranches(nodes, async n => {
    seen.set(n.id, (seen.get(n.id) || 0) + 1);
    if (n.id === 'bad') throw Error('stored session is corrupt');
    return { next: async () => ({ messages: [...shared, { role: 'user', text: n.id }], done: true }) };
  }, {});
  assert.equal(seen.get('bad'), 1);
  assert.match(result.failures['codex:bad'], /corrupt/);
  assert.equal(result.patches.find(p => p.key === 'codex:c').parentKey, 'codex:b');
  assert.ok(!result.patches.some(p => p.key === 'codex:b'));
});
test('前几条就不同只读取首批；没有共同前缀不按时间硬接分支', async () => {
  let pages = 0;
  const result = await compareBranches([node('a',1),node('b',2)], async n => ({ next: async () => { pages++; return { messages: [{ role: 'user', text: n.id }], done: false }; } }), {});
  assert.equal(pages, 2); assert.equal(result.patches.length, 0);
});
