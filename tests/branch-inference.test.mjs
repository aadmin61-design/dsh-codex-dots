import test from 'node:test';
import assert from 'node:assert/strict';
import { inferBranches, conversationMessages } from '../lib/branch-inference.mjs';
import { projectDepths } from '../lib/conversation-tree.mjs';

const row = (id, time, extra = {}) => ({ key: 'codex:' + id, id, source: 'codex', sourceCreatedAt: time, ...extra });
const shared = [{ role: 'user', text: '研究这个问题'.repeat(10) }, { role: 'assistant', text: '我们可以分为三个步骤'.repeat(10) }];
test('共同历史相同按创建时间选择最近较早父节点，计算连续分支深度', () => {
  const nodes = [row('a', 100), row('b', 200), row('c', 300)];
  const histories = new Map(nodes.map(n => [n.key, [...shared, { role: 'user', text: n.id }]]));
  const patches = inferBranches(nodes, histories);
  for (const p of patches) Object.assign(nodes.find(n => n.key === p.key), p);
  assert.equal(nodes[1].parentKey, nodes[0].key);
  assert.equal(nodes[2].parentKey, nodes[1].key);
  assert.equal(nodes[2].branchPoint.parentCreatedAt, 200);
  assert.deepEqual(projectDepths({ nodes }).nodes.map(n => n.depth), [1, 2, 3]);
});
test('更长历史优先于时间；原生与手动关系不被推断改写', () => {
  const nodes = [row('a', 100), row('b', 200), row('c', 300), row('manual', 400, { relationSource: 'manual' }), row('native', 500, { parentKey: 'codex:a' })];
  const longer = [...shared, { role: 'user', text: '继续原始方向' }];
  const histories = new Map(nodes.map(n => [n.key, n.id === 'b' ? shared : longer]));
  const patches = inferBranches(nodes, histories);
  assert.equal(patches.find(p => p.key === 'codex:c').parentKey, 'codex:a');
  assert.ok(!patches.some(p => ['codex:manual', 'codex:native'].includes(p.key)));
});
test('时间相同保留候选；短通用对话和镜像副本不产生推断分支', () => {
  const nodes = [row('a', 100), row('b', 100), row('c', 200), row('mirror', 150, { mirrorOf: 'codex:a' })];
  const histories = new Map(nodes.map(n => [n.key, shared]));
  const patches = inferBranches(nodes, histories);
  assert.equal(patches.length, 1); assert.equal(patches[0].unresolved, true);
  assert.deepEqual(patches[0].branchCandidates, ['codex:a', 'codex:b']);
  const short = new Map(nodes.map(n => [n.key, [{ role: 'user', text: '你好' }, { role: 'assistant', text: '你好' }]]));
  assert.deepEqual(inferBranches(nodes, short), []);
  assert.equal(conversationMessages({ messages: [{ role: 'tool', text: 'x' }, { role: 'user', text: ' a\r\nb ' }] })[0].text, 'a\nb');
});
