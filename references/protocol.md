# 工具参数与实现边界

## proposal 示例

先在 DSH 对话澄清目标与验收，DeepSeek 再生成此对象；实际目录及模型必须来自用户和 dots_probe。

```json
{
  "goal": "完成当前模块修复并验证",
  "plan": "先定位故障并汇报证据；主 agent 确认原因后派发修复；最后验证并验收。角色 reader 只分析，fixer 只改指定模块。",
  "workers": [
    {
      "name": "reader",
      "backend": "codex",
      "cwd": "C:\\work\\project",
      "role": "只读定位；不得修改文件",
      "instruction": "找出故障位置及最小修复建议，完成后结束本轮",
      "sandbox": "read-only"
    }
  ],
  "quota": { "stopAtLeftPercent": 25, "bucket": "codex", "windowMinutes": 10080 },
  "maxTurns": 12,
  "timeoutMs": 1800000,
  "allowedModels": [],
  "supervision": { "decisionTimeoutMs": 60000, "maxDecisionRetries": 2, "maxTotalReminders": 8 }
}
```

没有 model 时沿用 Codex 当前默认模型；没有 effort 时沿用其默认强度。allowedModels 是自动切换白名单，不填时不能自动选其他模型，但用户可以通过 dots_tune 的确认框增补。提供 model/effort 会在每轮启动前核对 `model/list`。

额度窗口：10080 分钟为周，300 分钟为五小时。省略 windowMinutes/bucket 表示任一实际返回窗口达到阈值就停。stopAtLeftPercent 为 null 表示未设置百分比阈值；仍保留最大轮数、超时和服务端费用控制。最多 12 个角色、200 次执行轮、单轮最多 2 小时。

所有角色首条指令进入队列；有依赖的角色填写 `dependsOn: ["reader"]`，只在前序角色经 dots_finish 验收后调度，并携带前序结论。未知依赖和环路在计划提交时拒绝。

## 模型可调用工具

| 工具 | 参数 | 作用 |
|---|---|---|
| dots_probe | 无 | 只读查询 Codex 当前模型、推理强度和额度 |
| dots_threads | options 可选 | 按 cwd/searchTerm/archived 查询本机持久对话，cursor 分页、limit 1–100；projects 为本页目录分组 |
| dots_thread_read | threadId, options 可选 | 最近历史，limit 1–10，cursor 分页；输出 historyIsUntrusted=true |
| dots_start | proposal | 双确认后建后台任务 |
| dots_status | runId 可选 | 本主对话一个或全部任务 |
| dots_dispatch | runId, worker, instruction, decisionId | 当前 worker.decision.id 校验通过才续发，拒绝旧事件重放 |
| dots_tune | runId, worker, changes | 下一轮 model/effort/timeoutMs/sandbox；扩权/超预算需确认 |
| dots_control | runId, action, budget 可选 | pause/resume/cancel/budget |
| dots_finish | runId, worker 可选, conclusion | 记录有证据的验收结果 |

工具没有 confirmed 布尔开关，用户确认只能由 DSH 的 userQuestions 返回；所有 runId 都校验主 agent 身份。子 agent 不能调用编排工具改变父任务。

Codex worker 可选 `existingThreadId`：从查询结果选定准确 ID，cwd 必须与原对话一致。两次确认中展示接管目标及历史头；创建时及每轮派发前校验状态和历史头。发现外部新轮次即暂停，需要重新核对并提交新计划。本插件内未结束任务独占该 ID；跨客户端没有原子互斥，接管期间应停止原客户端向该对话派发任务。调用 thread/resume 保留 ID，并重新施加本次计划的 sandbox/approvalPolicy。

`supervision` 的 decisionTimeoutMs 范围 1000–600000，maxDecisionRetries 为 0–5 整数，maxTotalReminders 为 0–30 整数。提醒只唤醒 DeepSeek 决策，不重试可能已经执行的 turn/start。达到任何次数上限即暂停。恢复会产生新 decision.id 和即时通知；累计 reminders 不随恢复清零。异常记录在 alerts（最近 30 条）及 JSONL。

## Host 配置

DSH 管理的插件行 `local-codex-dots` 支持：

| 配置 | 默认值 | 含义 |
|---|---|---|
| stateDir | `~/.dsh/codex-dots/v2` | 状态及审计日志 |
| codexBin | 自动发现 | Codex 可执行文件路径 |
| maxConcurrent | 3 | 同一宿主执行者总并发，1–3 |
| pollMs | 30000 | 活跃任务额度检查间隔，至少 1000ms |
| subagentProvider | spawn | DSH 已注册且支持 continuable 的 provider |

状态模型：ready → running → completed；中途可 paused → running，或 cancelled。角色模型：queued → starting → running → awaiting-decision → 下一轮 queued/验收 completed；收尾用 stopping，收到结束通知后 paused。不可并发写同一 threadId。

## 日志、回报和恢复

- `run-<UUID>.json`：目标、计划、确认记录、角色归属、threadId/childId、最后指令/回复、额度、轮数和待投递通知。原子重命名保存。
- `run-<UUID>.jsonl`：实时 app-server 通知和参数调整记录，包含用户任务内容，请按本地工作数据管理。
- `host.lock`：进程存活锁；不按时间过期，防止长轮次被并发驱动。
- outbox：主对话不驻留时留存通知；重新打开原对话后重试。投递为至少一次，崩溃边界可能重复，事件 ID 与角色状态用于去重。不会擅自创建新的主对话。
- 通知抛错按 5 秒、10 秒退避，连续 3 次失败后暂停并记录；离线返回不视为异常，不堆积相同决策。过期/已暂停决策事件丢弃。成功交给宿主不代表模型已经派发，决策监督器另行检查。

重启不自动恢复未完成指令，防止崩溃前已发生的文件修改被重做。Codex thread 可以 resume；DSH 子对话由原生 continuation manager 负责冷恢复。插件不直接操作 DSH/Codex 的历史数据库。

## 明确边界

- 原生 DSH 子对话继承主目录；read-only 是工具白名单约束，可写子对话继续受父 DSH 沙箱限制。
- 同目录冲突锁只覆盖本插件管理的执行者；外部编辑器、其他 DSH/Codex 任务不在锁内。
- Codex 的额外权限/用户输入请求会暂停任务；插件不会自动批准，也不提供危险全权限选项。
- 阈值是定期观测加收尾策略，不是供应商级费用硬限制；断网可能导致无法取得总结。
- Codex 侧 thread 的可续接性和桌面侧栏显示是两件事；不伪造来源字段来让侧栏显示。
- 不启用自动充值、额度重置或订阅购买；credits 字段只展示服务端返回值。

## 接口依据

已对照本机 DSH 0.2.0-rc.2 的 `dsh-agent`、`dsh-tools`、`dsh-user-questions`、`dsh-subagent` 与 `dsh-tool-subagent` 安装包，以及 Codex CLI 0.163.0 生成的 JSON Schema。

官方接口说明：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[终端 /statusline](https://learn.chatgpt.com/docs/developer-commands?surface=cli)。本机安装包静态检查 REA 证据：`ev_560018d57fce22bc1f6be2630de821003161b4166710f04634d5f9d199325c8d`，DSH ASAR SHA-256：`983ca71114e6dfd353fc79af5a1f9481a250ee64c2a3c757673029b811b23bc2`。静态证据不等于真实模型运行结果。

## 2.4.0 项目对话树

新增 dots_projects、dots_tree、dots_conversation_read、dots_conversation_create、dots_tree_link、dots_branch_summary。共享文件格式、CLI、迁移语义与额度说明见 [项目对话树](../docs/conversation-tree.md)。树的写入使用项目级短时锁，模型摘要不持锁；旧编排任务锁及额度边界保持不变。
