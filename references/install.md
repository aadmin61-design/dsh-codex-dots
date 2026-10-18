# 安装、升级与本机验证

本目录同时是 DSH skill 和无构建步骤的 Cordis 插件包，名称为 `@local/dsh-codex-dots`。主插件不需要 npm/Python 依赖安装，不读取或复制 API 密钥。

## 安装到 DSH

在 DSH「插件 → 添加插件」输入这个目录的绝对路径，使用 DSH 的安装按钮。或在 DSH 创造模式中要求原生 `plugin_manager` 执行：

```json
{"action":"install_bundle","target":"C:\\dsh-plugins\\codex-dots"}
```

这是插件安装，不是直接改 profile 文件；不要自行写 `~/.dsh/profiles/desktop/package.json` 或 `cordis.patch.yml`。插件由 DSH 管理器持久安装和启用。安装结果必须显示 applied，或明确处理 restart-required；仅文件存在不表示插件启用。

上面的路径是示例，须换成解压后包含 package.json 的实际目录。跨电脑安装请先阅读 [快速安装](../README.md)。本地 link 安装后不要移动或删除该目录。

本地目录安装使用 link。DSH 仅向链接包声明的 peerDependencies 提供宿主模块，因此 package.json 中的可选 peer 声明不可删除；optional 表示不让包管理器额外安装一份宿主模块。若先前尝试过缺失声明的版本，修复后需重启 DSH 清除失败的 ESM 导入缓存。

安装后在新的 DeepSeek 主对话读取 `codex-dots`，检查 `dots_status`、`dots_probe` 工具可调用。如果技能目录扫描被关，仍可通过插件自动加入的提示和 dots_* 工具使用；需要技能菜单条目时通过 DSH 自身管理器启用 skill-filesystem，不修改其他设置。

更新已安装代码通常需要 DSH 重启来加载新的 JavaScript 模块。不要在其他任务运行时自动重启应用。停止任务后再升级；任务状态在插件包目录之外，不随包替换删除。

## DSH 0.2.1 升级

DSH 0.2.1-rc.2 会拒绝仅声明 0.2.0-rc.2 宿主依赖的旧插件。请升级到 2.3.2，保留本地链接目录、配置和目录外的任务状态，重启后确认新版本；若升级时已被宿主停用，在插件详情重新启用，并核对组件运行状态。无需更改额度阈值或重新安装依赖环境。

## 验证命令

2.2.0 安装后，左侧「Codex 对话」进入项目树与消息预览；在已有 DSH 主对话顶部点击「Codex」，打开右侧对话列表，选中一项进入「代管 Codex 对话」。填写目标并提交后，DeepSeek 处理续接计划；真正执行仍经过启用/费用和计划确认。查询工具的结果也会自动打开侧栏。面板走宿主认证连接，不额外暴露 HTTP 服务。

2.3.0 复用 DSH 自带的 MarkdownText 和 Shiki 高亮，不安装新依赖。读取 `thread/turns/list` 时使用 `itemsView=full`，正文不截断；完整历史通过分页或「加载全部历史」访问。暂停和完成状态也会每 5 秒只读刷新，恢复/新轮次立即刷新；活动输出按消息 ID 合并。浏览器状态轮询只读取插件内存，不调用模型。

使用本机已有 Node.js：

```powershell
node --test tests/*.test.mjs
node scripts/codexctl.mjs probe
```

第一条使用可控协议替身验证状态机，不调用模型。第二条只读连接已登录的本机 Codex，返回账户实际模型列表和额度，启动 app-server 可能需要当前终端允许访问 Codex 用户目录。

Windows 的 DSH 安装产物可用于 Host 冒烟测试（按实际安装目录替换）：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'G:\DSH\DeepSeek Harness.exe' --expose-internals scripts/dsh-host-smoke.cjs 'G:\DSH\resources\app.asar\dsh' 2>&1 | Out-String
```

该测试复用已安装 DSH 的 Cordis、SystemPrompt 和 Tools，验证真实注册与卸载。用户回答、agent 和子 agent 是测试替身；不等同于真实模型闭环验证，不修改用户 profile。

## 在 DSH 中做一次真实验收

示例用户输入：

> 使用 codex-dots，在当前目录做一个只读测试。Codex 第一轮只回复 READY，你分析后让同一对话第二轮只回复 DONE，然后结束。最多两轮，周额度剩余 25% 时停止。先给我计划。

依次手动确认启用和计划。检查任务 ID、两个阶段的同一 threadId、前台等待时空闲、自动出现第二次阶段汇报、最终两轮完成。此验收会消耗模型额度，不由离线测试偷偷执行。

接管与恢复验收：用 dots_threads 查询并由用户选定一条已停止的测试对话，用 dots_thread_read 核对历史；计划设置 existingThreadId，首轮回复 READY2 后暂停。用户确认恢复后验证自动续发；若要检查漏派发保护，在测试计划中明确一次性故意忽略首次恢复通知，设置 supervision.decisionTimeoutMs=15000，观察自动提醒触发第二轮 DONE2。保持最大轮数 2，不额外发送催促消息，以日志中的 decision/reminder 和两条 turn/started 为证据。实际阈值按用户确认值填写，不能擅自降低。

DeepSeek 子对话验收：将 backend 设为 deepseek，cwd 必须为 DSH 主对话目录。要求两轮回答，确认同一 childId 续接、原生子对话面板能看到它。多个可写角色设同一目录，确认第二个排队；不同目录的 Codex 角色可以并行。

## 故障定位与卸载

- `DeepSeek Messages stream: tool input is invalid JSON / MALFORMED_RESPONSE`：这是宿主在工具派发前拒绝模型生成的非法 JSON。2.3.1 为 `dots_start` 提供结构化 schema，并在有明确未执行证据时每轮最多重生成一次；仍失败则保留原错误。更新后重启 DSH，再在原对话要求「保留已经确认的目标和约束，重新生成合法的 dots_start 参数并展示计划确认」。不要直接执行日志里的坏 JSON，也不要重放结果不明的工具。既有失败轮不会在更新后自动重开。
- `dots_*` 缺失：先核实包已启用及其服务依赖 agents/tools/subagents/userQuestions/systemPrompt。不要靠持续 goal 替代后台机制。
- PTC 的 `run_code` 在调用任何工具之前报 `SetNamedSecurityInfoW ... grantWrite`：这是该工作区的 DSH 执行器问题。可在标准模式直接调用本插件的原生工具做只读诊断；不要自动修改 ACL 或切换完全权限。
- 无 spawn provider：启用 DSH 原生子 agent 能力，或将插件配置 subagentProvider 设为已存在且支持 continuable 的 provider。
- Codex 未找到：在插件配置 codexBin 填本机可执行文件绝对路径，或设置 CODEX_BIN。不会自动下载 CLI。
- 登录失败：由用户在 Codex 完成正常登录；插件不处理认证界面。
- 额度为 null/所选窗口缺失：若设置阈值会暂停；不要将其当成余额为零或充足。
- 宿主重启：状态仍在，重新打开主对话，通过 dots_control resume 确认恢复，再给下一步。
- host.lock：只在原 PID 确认不存在时才自动恢复；不能用「超过 30 分钟」作为删锁理由。
- 卸载：先暂停任务，再在 DSH 插件管理器禁用/移除该包。保留用户任务状态，清理由用户另行指定。
