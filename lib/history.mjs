// 保留 app-server 可提供的完整消息字段；展示文本不再进行长度截断。
export function historyItem(item) {
  let text = item.text;
  if (text == null && item.type === 'userMessage') text = (item.content || []).map(b => b.text ?? JSON.stringify(b)).join('\n');
  if (text == null && item.type === 'reasoning') text = [...(item.summary || []), ...(item.content || [])].map(b => typeof b === 'string' ? b : b.text ?? JSON.stringify(b)).join('\n\n');
  if (text == null && item.type === 'commandExecution') text = [item.command, item.aggregatedOutput].filter(v => v != null).join('\n');
  return { ...item, text: String(text ?? JSON.stringify(item, null, 2)) };
}

// 按 turnId/itemId 保存当前轮增量，不能把一轮内的多条消息合并成一个尾部摘要。
export function updateLiveTurn(worker, method, p) {
  if (!['turn/started', 'turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta'].includes(method)) return;
  const turnId = p.turnId || p.turn?.id || worker.turnId;
  if (!turnId) return;
  if (method === 'turn/started') worker.liveTurn = { id: turnId, status: 'inProgress', items: [] };
  if (!worker.liveTurn || worker.liveTurn.id !== turnId) {
    if (worker.turnId && worker.turnId !== turnId) return;
    worker.liveTurn = { id: turnId, status: 'inProgress', items: [] };
  }
  const live = worker.liveTurn;
  live.updatedAt = Date.now();
  if (method === 'item/started' || method === 'item/completed') {
    const item = historyItem(p.item), index = live.items.findIndex(i => i.id === item.id);
    const entry = { ...item, liveComplete: method === 'item/completed' };
    if (index < 0) live.items.push(entry); else live.items[index] = entry;
  }
  if (method === 'item/agentMessage/delta') {
    const itemId = p.itemId || 'legacy-agent-message';
    let item = live.items.find(i => i.id === itemId);
    if (!item) { item = { id: itemId, type: 'agentMessage', text: '', liveComplete: false }; live.items.push(item); }
    if (!item.liveComplete) item.text += p.delta;
  }
  if (method === 'turn/completed') { live.status = p.turn.status; live.error = p.turn.error; }
}
