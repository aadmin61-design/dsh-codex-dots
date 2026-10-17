const MESSAGE = 'DeepSeek Messages stream: tool input is invalid JSON';

function malformedStart(attempt) {
  const stream = attempt?.data?.stream;
  if (!Array.isArray(stream)) return false;
  const calls = stream.filter(e => e.chunk?.type === 'block-end' && e.chunk.block?.type === 'tool-call').map(e => e.chunk.block);
  const finish = stream.findLast(e => e.chunk?.type === 'finish')?.chunk.reason;
  if (finish?.kind !== 'error' || finish.failure?.code !== 'MALFORMED_RESPONSE' || finish.failure?.message !== MESSAGE) return false;
  // 只恢复尚未执行的单个计划提交；混合工具、派发、工具执行失败一律不重放。
  if (calls.length !== 1 || calls[0].name !== 'dots_start') return false;
  try { JSON.parse(calls[0].arguments); return false; } catch { return typeof calls[0].arguments === 'string'; }
}

export function createRequestRecovery({ warn = () => {}, isDisposed = () => false } = {}) {
  return async ({ agent, turn, step, failure, signal }, next) => {
    if (isDisposed() || signal?.aborted) return;
    if (failure?.code !== 'MALFORMED_RESPONSE' || failure.message !== MESSAGE || agent?.session?.header?.origin === 'subagent') return next();
    const events = agent?.session?.snapshotEvents?.();
    if (!Array.isArray(events)) return next();
    const current = events.filter(e => e.data?.turn === turn && e.data?.step === step);
    const attempt = current.findLast(e => e.type === 'assistant/attempt');
    if (!malformedStart(attempt) || current.some(e => e.type === 'tool/call' || e.type === 'assistant/message' || e.type === 'step/end')) return next();
    // 计数取自持久化 attempt；重载插件不会重置本轮预算，不自动补括号或执行失败参数。
    const failures = events.filter(e => e.type === 'assistant/attempt' && e.data?.turn === turn && malformedStart(e)).length;
    if (failures !== 1) {
      warn('codex-dots：计划参数 JSON 重生成已达本轮 1 次上限，保留原错误并停止；请用户检查后重试。');
      return;
    }
    warn('codex-dots：dots_start 参数 JSON 无效且尚未执行，自动重新生成 1 次；仍须费用和计划确认。');
    return { kind: 'retry' };
  };
}
