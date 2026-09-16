# Ti Market Research

`ti-market-research` 是持久化技术研究入口，复用相邻 `subagent` 的会话、预算和只读数据桥，不再维护独立的子进程实现。它使用 `technical-analyst` 角色，返回带证据引用、风险与未知项的精简报告。`ti-trader` 发布包同时包含 `market-research`、`subagent` 和 `market-lab`。以下描述 Unreleased 源码功能。

## 使用

按需加载：设置 `TI_MARKET_RESEARCH=1`（或 `true` / `yes`），或在源码仓库通过 `--extension ./extensions/market-research` 显式加载。

```bash
TI_MARKET_RESEARCH=1 ti
```

工具：`market_research`。新研究使用 `question`，可附加 `symbol` 和 `timeframe`；返回 `sessionId` 与本次 `runId`。合约使用 `BTC/USDT:USDT` 等准确符号。

继续研究时传入 `sessionId` + `question`，不必重复历史。使用 `{"listSessions":true}` 查找当前作用域的技术研究会话，支持 `limit`（1–20）和 `offset`。列表模式不能与研究问题或 sessionId 混用。

历史保存在 Ti 数据目录的 `agent/subagents` 中，子进程退出后仍保留。交互重启须恢复同一父会话、cwd 和账户；自主运行时跨唤醒保持稳定所有权。缺失/损坏历史不会被空会话替代。会话保留、报告限制和角色配置详见 [Subagent](../subagent/README.md)。

默认不限制分析时长、模型回合、工具次数和累计 tokens，也没有子代理批次总超时；自定义角色显式设置的预算仍生效。手动取消、父运行时超时及输出大小保护保留，无默认分析预算意味着模型费用可能持续增长。

## 安全边界

子代理只使用角色和运行时共同允许的量化、市场只读工具，即使用户角色配置了 `propose_order`，此入口也会移除提案权限。它不查询账户持仓或执行下单、撤单、转账、提现，不创建交易所客户端。

Ti 内使用父会话同源 K 线，保留交易所、现货/合约及时间信息；没有 Ti 桥的独立模式才回退到明确标记的 Binance 公共现货数据，不能代替合约。延续历史时须刷新时效性证据。报告不是交易授权；模型认证仍可能产生费用。
