---
name: subagent
description: Persistent specialist research for Ti with discovery, continuation and cited reports. Children cannot trade.
metadata:
  version: 0.1.0
---

# Subagent

Use `subagent_agents` to discover effective specialists and available services. Delegate substantial independent analysis; keep simple reads direct and do not repeat correctly scoped child work in the parent.

Modes:

- New: `agent` + `task`
- Continue: `sessionId` + `task`, without resending the child history
- Parallel: `tasks` array
- Chain: `chain` array, with `{previous}` for the prior report
- Optional review: `review: {agent: "reviewer", task: "..."}` after the batch

Bundled roles: `scanner`, `technical-analyst`, `event-analyst`, `derivatives-analyst`, `strategy-analyst`, `reviewer`, and general `researcher`. Missing services are unknown evidence, not neutral votes. No mandatory pipeline or voting is required.

Analysis time, turns, tool calls and cumulative tokens have no default limits, and there is no default batch deadline. Omitted role budget fields mean unlimited; explicitly configured limits still apply. Finish when the task is answered rather than spending without purpose. Cancellation, parent-runtime deadlines, concurrency and output-size protections remain effective.

Use `subagent_sessions` after compaction or restart to recover owned handles. Interactive ownership requires the same parent session, cwd and account; autonomous ownership remains stable across wakes. Processes exit after each run; their JSONL histories persist. A busy or invalid session is an error, never a silent new conversation. Busy errors include `childPid` when a live child could not be reaped.

Children finish with `finish_analysis`: a concise summary, cited findings, risks, invalidation, unknowns and non-binding bias. Use `subagent_evidence` to resolve omitted reports or disputed claims. Historical evidence does not become fresh merely because it was read again. Child citation IDs are distinct from parent decision-ledger observation IDs.

Session-backed candles retain the parent's venue/market. Other research services are read-only proxies. Only approved roles can `propose_order`; this is not a fill. The parent must `check_order` then `buy`/`sell`. Paper/unattended: that parent call is the approval. Live/confirm: the operator confirmation box still appears.
