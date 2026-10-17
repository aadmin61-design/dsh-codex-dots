// 使用宿主支持的结构化参数，避免把长计划的数组/字段规则仅塞进一段描述。
const str = (description, required = true, values) => ({ type: 'string', description,
  ...(required ? { required: true } : {}), ...(values ? { enum: values } : {}) });
const num = description => ({ type: 'number', description });
const obj = (description, properties, required = false) => ({ type: 'object', description,
  additionalProperties: false, properties, ...(required ? { required: true } : {}) });
const strings = description => ({ type: 'array', description, items: { type: 'string' } });
const nullableNumber = description => ({ description, oneOf: [{ type: 'number' }, { type: 'null' }] });
export const proposalSchema = obj('完整计划对象。workers 必须为数组并闭合 ] 后再写 quota。长文放在 plan，instruction 仅写角色具体任务，避免重复整份计划。', {
  goal: str('本次目标'), plan: str('执行步骤、约束、产出和验收标准'),
  workers: { type: 'array', required: true, description: '1–12 个角色；单角色也必须为数组', items: obj('角色', {
    name: str('唯一小写角色名'), backend: str('执行后端', true, ['codex', 'deepseek']),
    cwd: str('真实绝对目录；Windows 可使用正斜杠'), role: str('职责与产出'), instruction: str('首轮具体指令'),
    dependsOn: strings('前序角色名'), sandbox: str('目录权限，默认只读', false, ['read-only', 'workspace-write']),
    model: str('dots_probe 返回的模型 ID', false), effort: str('模型支持的推理强度', false),
    existingThreadId: str('用户选定的已有 Codex 对话 ID', false), timeoutMs: num('角色超时，不超过计划上限'),
  }) },
  quota: obj('保留用户已确认的额度边界', {
    stopAtLeftPercent: nullableNumber('剩余百分比阈值 0–100；null 仅在用户明确不设阈值时使用'),
    bucket: { description: '额度桶', oneOf: [{ type: 'string' }, { type: 'null' }] },
    windowMinutes: nullableNumber('窗口分钟数'),
  }),
  allowedModels: strings('允许自动切换的模型 ID'), maxTurns: num('总轮数上限 1–200'), timeoutMs: num('单轮超时 1000–7200000 毫秒'),
  supervision: obj('后台决策监督', { decisionTimeoutMs: num('1000–600000 毫秒，默认 60000'),
    maxDecisionRetries: num('0–5，默认 2'), maxTotalReminders: num('0–30，默认 8') }),
}, true);
