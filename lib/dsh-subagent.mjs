// 0.2.2 的会话树接口与平铺 activation 参数一起发布；旧版继续使用 request。
export const usesFlatActivation = service => typeof service.rootOf === 'function';

// 新版不再接受 persona/toolFilter；在串行 agent/created 阶段施加，失败会阻止创建。
export function applyChildPolicy(agent, policy) {
  // tools.restrict 只过滤继承工具；guard 同时约束新版 preset 在子作用域注册的工具。
  const allowed = new Set(policy.toolFilter.allow);
  agent.ctx.get('tools').guard(exec => allowed.has(exec.name) ? undefined : 'codex-dots：该工具超出用户确认的子任务权限');
  agent.ctx.get('systemPrompt').section({ name: 'codex-dots:role', order: 5100,
    text: `${policy.persona}\n仅可调用这些工具：${[...allowed].join('、')}。其余工具会被拒绝。` });
}

// 按宿主能力选择创建接口；不能在创建失败后换接口重试，避免重复启动计费任务。
export async function startNativeChild(service, spec, onError) {
  let handle;
  if (typeof service.startActivation === 'function') {
    if (usesFlatActivation(service)) {
      const { request, ...activation } = spec;
      const { persona, toolFilter, ...requestFields } = request;
      handle = await service.startActivation({ ...activation, ...requestFields, delivery: 'parent' });
    } else handle = await service.startActivation({ ...spec, delivery: 'parent' });
  } else if (typeof service.startContinuable === 'function') {
    handle = await service.startContinuable(spec);
  } else {
    throw new Error('当前 DSH 没有可用的子对话创建接口，请检查宿主兼容版本');
  }
  // 只等待接收任务，不等待模型完成；原生 subagent/end 负责汇报完成与续接。
  // 新版结果捕获失败可能拒绝 promise，必须接住并上报，不能形成未处理拒绝。
  if (handle?.result?.then) void Promise.resolve(handle.result).catch(onError).catch(() => {});
  if (typeof handle?.childId !== 'string' || !handle.childId) throw new Error('DSH 未返回有效的子对话 ID');
  return handle;
}
