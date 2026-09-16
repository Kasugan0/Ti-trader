import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evidenceExtensionHarness, evidenceRuntime } from "../__tests__/evidence-fixture.ts";
import {
	type DecisionClaim,
	DecisionStore,
	evaluateDecisions,
	evidenceFingerprint,
	validateDecisionEvidence,
} from "./evidence.ts";
import { createDecisionEvidenceExtension } from "./extension.ts";

let root: string;
let now: number;
let store: DecisionStore;
beforeEach(() => {
	root = join(realpathSync(process.cwd()), `.ti-decisions-${randomUUID()}`);
	mkdirSync(root, { mode: 0o700 });
	now = Date.now();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(now);
	store = new DecisionStore(root, () => now);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	rmSync(root, { recursive: true, force: true });
});
const claim = (ids: string[] = []): DecisionClaim => ({
	action: "wait",
	symbol: "BTC/USDT",
	rationale: "No validated edge",
	invalidation: "Fresh evidence changes the assessment",
	horizon: "1h",
	uncertainties: ["Future direction"],
	observations: ids,
});
const fingerprint = evidenceFingerprint("prompt", [{ name: "get_price" }], "fixture");

describe("decision evidence, not model self-grading", () => {
	it("counts missing turns and capture gaps even when another turn has a recorded decision", () => {
		const { scope } = evidenceRuntime();
		const first = store.start(scope, "fixture", "model-a", fingerprint);
		store.record(first, claim(["missing-source"]));
		store.finish(first, "finished");
		const second = store.start(scope, "fixture", "model-a", fingerprint);
		store.finish(second, "finished", false);
		const report = evaluateDecisions({ version: 1, turns: store.list(scope) });
		expect(report.discipline.status).toBe("insufficient_evidence");
		expect(report.cohorts[0]).toMatchObject({ unrecordedTurns: 1, incompleteCaptureTurns: 1 });
	});
	it("treats empty, interrupted and uncited records as insufficient rather than passing", () => {
		const { scope } = evidenceRuntime();
		expect(evaluateDecisions({ version: 1, turns: [] }).discipline.status).toBe("insufficient_evidence");
		const id = store.start(scope, "fixture", "model-a", fingerprint);
		store.record(id, claim());
		store.finish(id, "interrupted");
		const report = evaluateDecisions({ version: 1, turns: store.list(scope) });
		expect(report.discipline.status).toBe("insufficient_evidence");
		expect(report.cohorts[0]).toMatchObject({
			nonTradingDecisions: 1,
			claimsWithoutEvidence: 1,
			interruptedTurns: 1,
		});
		expect(report.strategy.netReturn).toBeNull();
		expect(report.tradingAuthority).toBe("unchanged");
	});
	it("persists unknown IDs and exposes invalid citations without accepting model outcomes", () => {
		const { scope } = evidenceRuntime();
		const id = store.start(scope, "fixture", "model-a", fingerprint);
		store.record(id, claim(["invented-id"]));
		expect(() => store.record(id, { ...claim(), passed: true } as DecisionClaim)).toThrow(/Invalid/);
		store.finish(id, "finished");
		const report = evaluateDecisions({ version: 1, turns: new DecisionStore(root).list(scope) });
		expect(report.cohorts[0]).toMatchObject({ citations: 1, invalidCitations: 1 });
		expect(report.discipline.status).toBe("issues_observed");
		expect(() => store.record(id, claim())).toThrow(/sealed/);
		expect(store.list({ ...scope, accountId: "other" })).toEqual([]);
	});
	it.each(["fresh", "stale", "future", "missing-time", "other-symbol"] as const)(
		"evaluates %s citations deterministically",
		(kind) => {
			const { scope } = evidenceRuntime();
			const id = store.start(scope, "fixture", "model-a", fingerprint);
			store.update(id, (turn) =>
				turn.observations.push({
					id: "source-1",
					tool: "get_price",
					scope,
					sourceTimeVerified: true,
					at: new Date(now).toISOString(),
					sourceAt:
						kind === "missing-time"
							? null
							: new Date(now + (kind === "future" ? 1 : kind === "stale" ? -300001 : 0)).toISOString(),
					symbol: kind === "other-symbol" ? "ETH/USDT" : "BTC/USDT",
					status: "observed",
					snapshot: { last: 100 },
					digest: "a".repeat(64),
				}),
			);
			store.record(id, claim(["source-1"]));
			store.finish(id, "finished");
			const report = evaluateDecisions({ version: 1, turns: store.list(scope) });
			expect(report.discipline.status).toBe(
				kind === "fresh"
					? "no_recorded_discipline_issues"
					: kind === "missing-time"
						? "insufficient_evidence"
						: "issues_observed",
			);
			expect(report.strategy.status).toBe("insufficient_evidence");
		},
	);
	it("separates cohorts and never lets a retrospective reason repair an earlier unrecorded mutation", () => {
		const { scope } = evidenceRuntime();
		const id = store.start(scope, "fixture", "model-a", fingerprint);
		store.update(id, (turn) =>
			turn.mutations.push({
				id: "attempt",
				at: new Date(now).toISOString(),
				tool: "buy",
				symbol: "BTC/USDT",
				decisionIds: [],
				outcome: "unknown",
			}),
		);
		store.record(id, { ...claim(), action: "enter" });
		store.finish(id, "finished");
		const other = store.start(scope, "fixture", "model-b", evidenceFingerprint("new prompt", [], "fixture"));
		store.finish(other, "finished");
		const report = evaluateDecisions({ version: 1, turns: store.list(scope) });
		expect(report.cohorts).toHaveLength(2);
		expect(report.cohorts[0]).toMatchObject({
			mutationAttempts: 1,
			unrecordedMutations: 1,
			retrospectiveClaims: 1,
			unknownOutcomes: 1,
		});
	});
	it("captures public numeric observations and actual attempts without raw error/provider content", async () => {
		const f = evidenceRuntime();
		const h = evidenceExtensionHarness();
		createDecisionEvidenceExtension(() => f.runtime, store, "fixture")(h.api);
		await h.emit("before_agent_start", { systemPrompt: "PRIVATE-PROMPT" });
		await h.emit("tool_call", { toolName: "get_price", toolCallId: "call|compound", input: { symbol: "BTC/USDT" } });
		await h.emit("tool_result", {
			toolName: "get_price",
			toolCallId: "call|compound",
			input: { symbol: "BTC/USDT" },
			isError: false,
			content: [{ type: "text", text: "PRIVATE-RAW-RESPONSE" }],
			details: { last: 100, time: new Date(now).toISOString(), raw: "SECRET-KEY", warnings: [] },
		});
		const observation = store.list(f.scope)[0].observations[0];
		const tool = h.tools.get("record_decision")!;
		await tool.execute("claim", claim([observation.id]), undefined, undefined, h.ctx);
		await h.emit("tool_call", { toolName: "buy", toolCallId: "buy|compound", input: { symbol: "BTC/USDT" } });
		await h.emit("tool_result", {
			toolName: "buy",
			toolCallId: "buy|compound",
			input: { symbol: "BTC/USDT" },
			content: [{ type: "text", text: "Risk blocked SECRET-KEY" }],
			isError: true,
		});
		await h.emit("agent_end", { messages: [] });
		const raw = readFileSync(store.storage.path, "utf8");
		expect(raw).not.toContain("PRIVATE");
		expect(raw).not.toContain("SECRET");
		expect(store.list(f.scope)[0].mutations[0].outcome).toBe("blocked");
		expect(h.notify).not.toHaveBeenCalled();
	});
	it("rejects corrupt chronology and duplicated evidence", () => {
		const { scope } = evidenceRuntime();
		const id = store.start(scope, "fixture", "model-a", fingerprint);
		store.record(id, claim());
		const evidence = { version: 1 as const, turns: store.list(scope) };
		evidence.turns[0].claims[0].at = new Date(now - 1).toISOString();
		expect(() => validateDecisionEvidence(evidence)).toThrow(/chronology/);
	});
});
