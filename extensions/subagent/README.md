# Ti Subagent

父会话通过 `subagent` 把多步骤研究交给专业子代理，只接收精简报告和证据引用，不重复读取整份子对话。简单价格或指标查询仍可直接完成。子代理会话持久保存，进程每次调用后退出；后续调用可恢复同一份历史，不需要常驻进程。

以下描述 Unreleased 源码功能。子进程是 coding-agent，不是嵌套的 `ti`；它不能交易。部分角色可 `propose_order`，但主 agent 仍须 `check_order` 再 `buy`/`sell`。Paper/unattended 下主 agent 的执行调用就是批准；live/confirm 下仍须操作者确认。

## 使用

按需加载：设置 `TI_SUBAGENT=1`（或 `true` / `yes`），或 `--extension ./extensions/subagent`。

```bash
TI_SUBAGENT=1 ti
```

### 工具与会话

| 工具 | 用途 |
| --- | --- |
| `subagent_agents` | 分页发现实际角色、模型、预算、可用工具和缺失服务 |
| `subagent` | 新建、继续、并行、串行研究，以及可选复核 |
| `subagent_sessions` | 分页查找当前父会话与账户拥有的研究会话，不返回完整对话 |
| `subagent_evidence` | 按 `sessionId` / `runId` 读取已保存报告、提案及证据索引；按 `evidenceId` 读取证据片段 |

- 新建：`agent` + `task`
- 继续：`sessionId` + `task`；`agent` 可省略，不能借此更换原角色
- 并行：`tasks`（最多 4 个，并发 2）
- 串行：`chain`（最多 8 步），任务文本里的 `{previous}` 替换为上一步报告
- 复核：附加 `review: { agent: "reviewer", task: "..." }`，直接向复核者提供各项报告和可读证据；不要求固定流水线或投票
- 约束：可选 `context: { symbols, timeframes, constraints }`

调用示例：

```json
{
  "tasks": [
    { "agent": "technical-analyst", "task": "分析 BTC/USDT:USDT 的 1h 结构与失效条件" },
    { "agent": "derivatives-analyst", "task": "分析同一合约的资金费率、未平仓量及订单簿风险" }
  ],
  "review": { "agent": "reviewer", "task": "指出分歧、过期证据和待补充信息，不执行交易" }
}
```

保存返回的 `sessionId`；随后传入 `{"sessionId":"<返回的 UUID>","task":"刷新行情，继续评估原来的失效条件"}`。同一会话保持 `sessionId`，每次调用获得新的 `runId`。同名角色可拥有多条独立研究会话。

### 专业角色

| 角色 | 分工 |
| --- | --- |
| `scanner` | 标的筛选、覆盖率与缺失数据 |
| `technical-analyst` | 技术指标、结构与闭合 K 线证据 |
| `event-analyst` | 新闻、事件及来源交叉核对 |
| `derivatives-analyst` | 合约信息、资金费率、未平仓量和订单簿 |
| `strategy-analyst` | 有界规则回放及 Freqtrade 策略证据 |
| `reviewer` | 检查报告分歧、引用和风险，不授予交易权限 |
| `researcher` | 通用量化研究，可向父会话提出未提交订单 |

先查询实际目录，不假定所有服务都可用。新闻工具依赖父会话已加载的 web/知乎服务；Freqtrade 依赖已配置侧车。角色可请求的工具还要与运行时能力取交集，缺失服务明确返回，不会虚构数据。

用户角色位于 `${TI_DATA_DIR:-~/.ti-trader}/agent/agents/*.md`。项目角色位于最近的 `.ti-trader/agents/*.md`；通过 `agentScope: "project" | "both"` 显式选择。未信任项目必须确认，无 UI 时拒绝；模型不能关闭确认。角色使用父会话 cwd，修改角色提示词、工具、模型或来源后须新建会话。

角色文件示例：

```markdown
---
name: my-technical
description: Technical research
tools: calculate_indicators,evaluate_strategy
---
Refresh market facts. Cite tool evidence and finish with finish_analysis.
```

`model` 可设为 `provider/model`；省略时在会话创建时继承父模型，继续时保留最初选择。未指定 `tools` 时仍使用原有四个 market-lab 工具和 `propose_order`，不会默认获得全部新服务。

## 持久化与恢复

历史 JSONL、会话元数据和各次调用记录保存在 `${TI_DATA_DIR:-~/.ti-trader}/agent/subagents/<ownership-hash>/<sessionId>/`。文件权限 600，所属会话目录 700。JSONL 使用现有 SessionManager，恢复时遵循已有压缩记录；这不意味着模型上下文无限增长。

交互模式按父会话 ID、cwd 和实际账户作用域隔离。重启后须恢复原父会话、相同 cwd 和账户，再调用 `subagent_sessions`；全新父会话不会自动继承其他父会话的子研究。自主运行时使用稳定的 `autonomous` 所有者及实际账户作用域，不依赖每次唤醒的临时父会话 ID。

同一子会话只有一个写入者；忙碌时返回错误，不偷偷分叉。恢复前核对元数据、角色指纹和历史文件身份；文件丢失或损坏不会创建空对话冒充继续。取消、超时或崩溃保留已有历史。重新调用时检查锁与记录的子进程：父进程已死后仍存活的孤儿会被终止，未完成旧调用标为 interrupted；无法终止时返回带 `pid` 的 busy 错误。列表中的 `running` 可能尚待恢复检查，不能据此判断进程仍存活。

会话和调用记录不会自动删除，须监控磁盘增长。备份应在相关进程停止后包含整个 `agent/subagents` 目录。历史研究可能包含敏感内容，不应上传或提交到仓库。过期报告、过去提案以及读取旧证据都不是当前市场事实，也不会自动重发提案或交易。

## 报告与预算

子代理必须单独调用 `finish_analysis`，提交 `summary`、带 `evidenceIds` 的 `findings`、`risks`、`invalidation`、`unknowns` 和非约束性 `bias`（`long` / `short` / `none`）。没有有效报告、引用不存在或失败的证据时，本次调用失败。

单份报告最多 8 KiB；父会话批量结果最多 32 KiB，超出时明确返回报告句柄而不是静默截断风险。须通过 `subagent_evidence` 读取被省略的报告后再判断。省略 `evidenceId` 时，证据索引按 `offset` / `limit` 分页（默认 20 条）；指定 `evidenceId` 后，证据片段最多 16 KiB，按返回的 `nextOffset`（字符偏移）继续。会话列表只给短预览，完整历史不会随普通报告注入父模型。

所有内置角色默认不限制分析时长、模型回合、工具调用次数或累计 tokens，整个子代理批次也没有默认总超时。`TI_SUBAGENT` 仍只是启用开关，不控制预算；`market_research` 使用同样的无限制默认值。

自定义角色可显式填写 `timeoutMs`、`maxTurns`、`maxToolCalls`、`maxTokens`；省略某字段表示该项不限，不使用 `0` 或 `null` 代替。显式值必须是正安全整数；`timeoutMs` 受 Node 定时器范围约束，最大 2147481647 毫秒（预留两秒退出保护）。其余字段不再受原来的 20 回合、64 次工具或 200000 tokens 等策略上限约束。显式 token 限制在完整响应边界检查，可能超出一个响应，并非硬性费用上限。

不限分析预算不代表免费或无法终止：手动取消、父进程断开以及自主运行时单独配置的 `modelTimeoutMs` 仍会中断研究，供应商上下文窗口和单次服务请求限制也不变。同一父进程、同一作用域仍共享两个执行槽，每次最多四个提案，子进程 JSON 输出上限仍为 8 MiB。报告及证据分页的大小保护保留；无限制分析可能持续消耗模型费用，需要时主动取消。

## 安全边界

父进程通过受审查的只读 IPC 桥提供市场、新闻和策略服务；不会把交易所或侧车凭证转发给子进程。Ti 内的 K 线来自父会话相同交易所和市场，批次共享截止时间并复用相同请求；继续研究会重新取数。即使父模型未启用 market-lab 工具，已安装会话 K 线桥的子代理仍可使用内置量化工具。独立加载且无 Ti 桥时仅允许明确标记的 Binance 公共现货回退，不能冒充合约数据。

`buy`、`sell`、账户修改、通用文件与 `bash` 工具不在白名单中。模型认证通过 `PI_CODING_AGENT_DIR`（默认 Ti 数据目录下的 `agent`）复用，仍可能产生模型费用。进程隔离和工具白名单不是操作系统沙箱，不应加入任意代码执行工具。报告、复核和提案都不能绕过父运行时的账户检查、风控与审批。
