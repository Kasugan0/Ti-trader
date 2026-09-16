---
name: market-research
description: Read-only market research subagent for Ti. Uses technical analysis only and cannot trade.
metadata:
  version: 0.1.0
---

# Market Research

Use `market_research` for substantial technical research and a concise cited report. Include the symbol and timeframe when known; simple reads may stay in the parent.

Save its `sessionId`. Continue with `sessionId` and a new `question`; the child restores its persistent history. Use `listSessions: true` with optional `limit`/`offset` to recover owned technical research handles. A new parent session or different account is a separate scope.

The tool shares the specialist runtime and technical-analyst role, with order proposals disabled. Market-lab and available parent market reads are permitted; account and execution tools are not. Ti-backed candles retain the session venue and market, including futures. Binance public spot is only the explicit fallback without a Ti bridge.

Refresh historical market facts before reaching a new conclusion. Reports must cite real evidence, disclose missing data and risks, and treat bias as non-binding. Trading remains exclusively in Ti's native tools and confirmation flow.
