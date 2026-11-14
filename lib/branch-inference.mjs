// 只比较完整用户/助手历史的共同前缀；短问候不能成为分支证据。
export const conversationMessages = history => history.messages.filter(m => ['user', 'assistant'].includes(m.role))
  .map(m => ({ ...m, text: (m.text || '').replace(/\r\n/g, '\n').trim() }));
export function sharedPrefix(a, b) {
  let count = 0, chars = 0, ids = 0;
  for (; count < Math.min(a.length, b.length); count++) {
    if (a[count].role !== b[count].role || a[count].text !== b[count].text) break;
    chars += a[count].text.length;
    if (a[count].id && a[count].id === b[count].id) ids++;
  }
  return { count, chars, ids };
}
export function inferBranches(nodes, histories, scores) {
  const patches = [];
  for (const child of nodes) {
    if (child.mirrorOf || child.hiddenReason || child.unavailable || child.parentKey || child.relationSource === 'manual' || (!scores && !histories.has(child.key))) continue;
    const candidates = [], undated = [];
    for (const parent of nodes) {
      if (parent.key === child.key || parent.mirrorOf || parent.hiddenReason || parent.unavailable || parent.source !== child.source || (!scores && !histories.has(parent.key))) continue;
      const prefix = scores ? scores.get(JSON.stringify([child.key, parent.key])) : sharedPrefix(histories.get(parent.key), histories.get(child.key));
      if (!prefix) continue;
      if (prefix.count < 2 || (prefix.chars < 80 && prefix.ids < 2)) continue;
      if (!parent.sourceCreatedAt || !child.sourceCreatedAt) undated.push(parent.key);
      else if (parent.sourceCreatedAt < child.sourceCreatedAt) candidates.push({ key: parent.key, createdAt: parent.sourceCreatedAt, ...prefix });
    }
    // 共同历史相同时，按用户要求选择最近创建的较早对话。
    candidates.sort((a, b) => b.count - a.count || b.chars - a.chars || b.createdAt - a.createdAt);
    if (!candidates.length) { if (undated.length) patches.push({ key: child.key, unresolved: true, branchCandidates: undated }); continue; }
    const best = candidates[0], tied = candidates.filter(c => c.count === best.count && c.chars === best.chars && c.createdAt === best.createdAt);
    // 时间也完全相同时才保留待确认，不依据列表顺序任意选择。
    if (tied.length > 1) patches.push({ key: child.key, unresolved: true, branchCandidates: tied.map(c => c.key) });
    else patches.push({ key: child.key, parentKey: best.key, unresolved: false, relationSource: 'content',
      branchPoint: { sharedMessages: best.count, sharedChars: best.chars, parentCreatedAt: best.createdAt, childCreatedAt: child.sourceCreatedAt, nextMessageId: scores ? best.nextMessageId : histories.get(child.key)[best.count]?.id || null },
      intent: '共同历史之后继续不同方向；具体意图待补充', reasonStatus: 'pending', branchCandidates: [] });
  }
  return patches;
}
