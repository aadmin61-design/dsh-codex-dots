import { randomUUID } from 'node:crypto';

// 将 Codex 历史变成 DSH 已完成的历史轮次。工具记录仅作为文本资料，绝不重放调用。
export function codexToDshEvents(thread, now = Date.now()) {
  const events = [];
  const add = (type, data, surface = false) => events.push({ type, data, seq: events.length, time: now, ...(surface ? { surfaceOp: 'append' } : {}) });
  const message = (role, text) => ({ id: randomUUID(), role, content: [{ type: 'text', text }],
    source: role === 'assistant' ? { kind: 'model', provider: 'codex-history-import', model: thread.model || 'codex-history' } : { kind: 'user' } });
  let turn = 0;
  // readThread 分页按新到旧返回，先恢复时间顺序；单轮中的消息顺序保持不变。
  for (const original of [...thread.turns].reverse()) {
    turn++; const step = 1;
    add('turn/start', { turn }); add('step/start', { turn, step });
    if (turn === 1) add('system/message', { turn, step, message: { id: randomUUID(), role: 'system', content: [], source: { kind: 'system-prompt' } } }, true);
    for (const item of original.items) {
      if (item.type === 'userMessage') add('user/message', message('user', item.text), true);
      else {
        const text = item.type === 'agentMessage' ? item.text : `历史记录（${item.type}，仅供参考）：\n${item.text}`;
        add('assistant/message', { turn, step, message: message('assistant', text), stream: [] }, true);
      }
    }
    add('step/end', { turn, step }); add('turn/end', { turn, reason: { kind: 'completed' } });
  }
  add('session/title', { title: thread.title, messageSeqs: [], source: { kind: 'user' } });
  return events;
}

// 面板完整展示可见用户/模型/工具消息；原始事件另行保留，不按正文长度截断。
export function dshHistory(snapshot) {
  return snapshot.events.flatMap(event => {
    const message = event.type === 'user/message' ? event.data : event.data?.message;
    if (!message || !['user', 'assistant', 'tool'].includes(message.role)) return [];
    return [{ id: message.id || String(event.seq), role: message.role, seq: event.seq,
      text: (message.content || []).map(block => block.text ?? JSON.stringify(block, null, 2)).join('\n\n') }];
  });
}
