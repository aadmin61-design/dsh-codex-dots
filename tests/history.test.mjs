import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { CodexClient } from '../lib/codex.mjs';
import { historyItem, updateLiveTurn } from '../lib/history.mjs';

let view;
vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load: d => { view = d.factory(() => ({})); } } },
});

test('分支分页只调用 turns/list，从头小页读取且不转换工具输出', async () => {
  const client = new CodexClient({ bin: 'unused' }); const calls = [];
  client.call = async (method, params) => { calls.push({ method, params }); return { data: [{ id: 't', items: [
    { type:'userMessage', id:'u', content:[{type:'text',text:'问题'}] },
    { type:'agentMessage', id:'a', text:'完整回答' },
    { type:'commandExecution', id:'tool', aggregatedOutput:'大段工具输出'.repeat(1000) },
  ] }], nextCursor:'next' }; };
  const page = await client.readTurns('thread', { cursor:'start',limit:2,direction:'asc',messagesOnly:true });
  assert.equal(calls.length,1); assert.equal(calls[0].method,'thread/turns/list');
  assert.equal(calls[0].params.sortDirection,'asc'); assert.equal(calls[0].params.limit,2);
  assert.deepEqual(page.turns[0].items.map(i=>i.type),['userMessage','agentMessage']);
});

test('完整历史保留超过 6000 字的首尾、工具字段与分页游标', async () => {
  const text = '首部\n' + '完整正文'.repeat(4000) + '\n尾部';
  const client = new CodexClient({ bin: 'unused' });
  client.call = async (method, params) => {
    if (method === 'thread/read') return { thread: { id: 't', name: '完整历史' } };
    assert.equal(params.itemsView, 'full'); assert.equal(params.cursor, 'page-2');
    return { data: [{ id: 'turn', items: [{ type: 'agentMessage', id: 'a', text }, { type: 'commandExecution', id: 'c', command: 'echo test', aggregatedOutput: text, exitCode: 0 }] }], nextCursor: 'page-3' };
  };
  const result = await client.readThread('t', { cursor: 'page-2' });
  assert.equal(result.turns[0].items[0].text, text);
  assert.equal(result.turns[0].items[1].aggregatedOutput, text);
  assert.equal(result.turns[0].items[1].exitCode, 0); assert.equal(result.nextCursor, 'page-3');
  assert.match(historyItem({ type: 'userMessage', content: [{ type: 'text', text: '正文' }, { type: 'image', url: 'test' }] }).text, /正文.*\n.*image/);
});

test('多条实时消息保持独立且不截断，落盘合并无重复、无文本回退', () => {
  const worker = { turnId: 'turn' }, text = '# 标题\n' + '中文'.repeat(16000);
  updateLiveTurn(worker, 'turn/started', { turn: { id: 'turn' } });
  updateLiveTurn(worker, 'item/agentMessage/delta', { turnId: 'turn', itemId: 'a', delta: '第一条' });
  updateLiveTurn(worker, 'item/completed', { turnId: 'turn', item: { id: 'a', type: 'agentMessage', text: '第一条完整' } });
  updateLiveTurn(worker, 'item/agentMessage/delta', { turnId: 'turn', itemId: 'b', delta: text });
  const saved = [{ id: 'turn', items: [{ id: 'a', type: 'agentMessage', text: '第一条完整' }, { id: 'b', type: 'agentMessage', text: text + '已保存的结尾' }] }];
  const merged = view.withLive(saved, worker.liveTurn, true);
  assert.equal(merged.length, 1); assert.equal(merged[0].items.length, 2);
  assert.equal(merged[0].items[1].text, text + '已保存的结尾');
  assert.equal(worker.liveTurn.items[1].text, text);
  updateLiveTurn(worker, 'turn/completed', { turn: { id: 'turn', status: 'interrupted' } });
  assert.equal(view.withLive([], worker.liveTurn, false)[0].status, 'interrupted');
  updateLiveTurn(worker, 'turn/started', { turn: { id: 'next' } });
  assert.equal(worker.liveTurn.items.length, 0);
});

test('历史翻页后刷新保留更早轮次，最新内容优先且顺序不变', () => {
  const old = [{ id: 'b', items: ['旧文本'] }, { id: 'a', items: [] }];
  const latest = [{ id: 'c', items: [] }, { id: 'b', items: ['新文本'] }];
  const merged = view.mergeTurns(latest, old);
  assert.equal(JSON.stringify(merged.map(t => t.id)), '["c","b","a"]');
  assert.equal(merged[1].items[0], '新文本');
  assert.equal(view.mergeTurns(merged, [{ id: 'a' }, { id: 'earliest' }]).at(-1).id, 'earliest');
});
