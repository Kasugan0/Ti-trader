import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionRecord, ExecutionScope, Ticker } from "@nikopack/ti-trading-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evidenceRuntime as baseEvidenceRuntime, evidenceExtensionHarness } from "../__tests__/evidence-fixture.ts";
import { PrivateStore } from "../private-store.ts";
import { createGetPriceTool } from "../tools/market.ts";
import { DecisionOutcomeCollector } from "./collector.ts";
import { evaluateActualExecutions } from "./evaluation.ts";
import { type DecisionClaim, DecisionStore, evaluateDecisions, evidenceFingerprint } from "./evidence.ts";
import { createDecisionEvidenceExtension } from "./extension.ts";
import { decisionEvaluationPage } from "./presentation.ts";
import { type StudyConfig, validateStudyConfig } from "./protocol.ts";

let root: string;
let now: number;
let store: DecisionStore;
const config: StudyConfig = {
	name: "prospective-spot",
	symbols: ["BTC/USDT"],
	horizonSeconds: 60,
	maxSourceAgeSeconds: 30,
	endpointWindowSeconds: 20,
	feeBpsPerSide: 10,
	slippageBpsPerSide: 5,
	minimumSamples: 20,
};
const fingerprint = evidenceFingerprint("prompt", ["get_price", "record_decision"], "fixture");
function observedTicker(last = 100) {
	return { symbol: "BTC/USDT", last, bid: last - 0.1, ask: last + 0.1, timestamp: now, sourceTimestampKnown: true };
}
function evidenceRuntime() {
	const fixture = baseEvidenceRuntime();
	vi.mocked(fixture.exchange.getTicker).mockImplementation(async () => observedTicker());
	return fixture;
}
const claim: DecisionClaim = {
	action: "enter",
	symbol: "BTC/USDT",
	rationale: "A public directional forecast, not proof of reasoning.",
	invalidation: "Evidence changes.",
	horizon: "Model prose does not set the endpoint",
	uncertainties: ["Direction"],
	observations: ["entry"],
	forecast: { direction: "up" },
};
beforeEach(() => {
	root = join(process.cwd(), `.decision-study-${randomUUID()}`);
	mkdirSync(root, { mode: 0o700 });
	now = Date.parse("2026-09-15T00:00:00.000Z");
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(now);
	store = new DecisionStore(root, () => now);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	rmSync(root, { recursive: true, force: true });
});
function advance(ms: number): void {
	now += ms;
	vi.setSystemTime(now);
}
function enroll(
	scope: ExecutionScope,
	input = claim,
	source: Partial<{ sourceAt: string | null; symbol: string; scope: ExecutionScope; at: string; price: number }> = {},
) {
	const turnId = store.start(scope, "fixture", "model", fingerprint);
	store.update(turnId, (turn) =>
		turn.observations.push({
			id: "entry",
			tool: "get_price",
			at: source.at ?? new Date(now).toISOString(),
			sourceAt: source.sourceAt === undefined ? new Date(now).toISOString() : source.sourceAt,
			scope: source.scope ?? scope,
			symbol: source.symbol ?? "BTC/USDT",
			status: "observed",
			snapshot: { last: source.price ?? 100 },
			sourceTimeVerified: true,
			digest: "a".repeat(64),
		}),
	);
	const claimId = store.record(turnId, input);
	store.finish(turnId, "finished");
	return { turnId, claimId };
}

describe("operator-frozen prospective studies", () => {
	it("preserves legacy records, prevents retroactive enrollment and freezes protocol, source and claims", () => {
		const { scope } = evidenceRuntime();
		const legacy = store.start(scope, "fixture", "model", fingerprint);
		const study = store.confirmStudy(scope, config);
		store.record(legacy, claim);
		expect(store.list(scope)[0].claims[0].evaluation).toBeUndefined();
		expect(() => store.confirmStudy(scope, config)).toThrow(/Stop the active/);
		expect(() =>
			store.update(legacy, (turn) => {
				turn.claims[0].claim.rationale = "rewritten";
			}),
		).toThrow(/immutable/);
		study.config.feeBpsPerSide = 500;
		expect(store.evidence(scope).studies![0].config.feeBpsPerSide).toBe(10);
		expect(() =>
			store.storage.transact((state) => {
				state.studies![0].config.horizonSeconds = 120;
			}),
		).toThrow(/frozen/);
		store.finish(legacy, "finished");
		enroll(scope);
		const saved = new DecisionStore(root).evidence(scope);
		expect(saved.turns).toHaveLength(2);
		expect(saved.turns[1].claims[0].evaluation?.dueAt).toBe(new Date(now + 60_000).toISOString());
		expect(saved.studies![0].digest).toHaveLength(64);
		expect(() => validateStudyConfig({ ...config, endpointWindowSeconds: 100 })).toThrow(/horizon/);
	});
	it.each(["future", "stale", "missing", "scope", "symbol", "nonpositive", "uncited"] as const)(
		"does not invent a prospective entry when source evidence is %s",
		(kind) => {
			const { scope } = evidenceRuntime();
			store.confirmStudy(scope, config);
			enroll(scope, kind === "uncited" ? { ...claim, observations: [] } : claim, {
				...(kind === "future" ? { sourceAt: new Date(now + 1).toISOString() } : {}),
				...(kind === "stale" ? { sourceAt: new Date(now - 30_001).toISOString() } : {}),
				...(kind === "missing" ? { sourceAt: null } : {}),
				...(kind === "scope" ? { scope: { ...scope, accountId: "another" } } : {}),
				...(kind === "symbol" ? { symbol: "ETH/USDT" } : {}),
				...(kind === "nonpositive" ? { price: 0 } : {}),
			});
			expect(store.evidence(scope).outcomes![0].reason).toBe("missing-trusted-prospective-entry");
			expect(evaluateDecisions(store.evidence(scope)).strategy.cohorts[0].meanStrategyReturn).toBeNull();
		},
	);
	it("cannot repair an original cited observation or turn a post-mutation claim into prospective evidence", () => {
		const { scope } = evidenceRuntime();
		store.confirmStudy(scope, config);
		const id = store.start(scope, "fixture", "model", fingerprint);
		store.update(id, (turn) =>
			turn.observations.push({
				id: "entry",
				tool: "get_price",
				at: new Date(now).toISOString(),
				sourceAt: null,
				scope,
				symbol: "BTC/USDT",
				status: "partial",
				snapshot: { last: 100 },
				digest: "a".repeat(64),
			}),
		);
		expect(() =>
			store.update(id, (turn) => {
				turn.observations[0].sourceAt = new Date(now).toISOString();
			}),
		).toThrow(/immutable/);
		store.update(id, (turn) =>
			turn.mutations.push({
				id: "attempt",
				tool: "buy",
				at: new Date(now).toISOString(),
				decisionIds: [],
				outcome: "unknown",
			}),
		);
		store.record(id, claim);
		expect(store.evidence(scope).outcomes![0].reason).toBe("retrospective-claim");
	});
});

describe("bounded observer and fixed endpoints", () => {
	it("deduplicates ticker reads, freezes the first endpoint, and resumes idempotently without mutation", async () => {
		const f = evidenceRuntime();
		store.confirmStudy(f.scope, config);
		enroll(f.scope);
		enroll(f.scope);
		const collector = new DecisionOutcomeCollector(
			store,
			() => f.runtime,
			() => now,
		);
		expect(await collector.collect()).toMatchObject({ requests: 0 });
		advance(60_000);
		vi.mocked(f.exchange.getTicker).mockResolvedValue(observedTicker(110));
		expect(await collector.collect()).toMatchObject({ observed: 2, requests: 1 });
		const saved = store.evidence(f.scope);
		const resumed = new DecisionOutcomeCollector(
			new DecisionStore(root, () => now),
			() => f.runtime,
			() => now,
		);
		advance(5000);
		vi.mocked(f.exchange.getTicker).mockResolvedValue(observedTicker(200));
		expect(await resumed.collect()).toMatchObject({ observed: 0, requests: 0 });
		expect(store.evidence(f.scope)).toEqual(saved);
		expect(f.placeOrder).not.toHaveBeenCalled();
		expect(f.exchange.cancelOrder).not.toHaveBeenCalled();
		expect(f.exchange.cancelOrderList).not.toHaveBeenCalled();
	});
	it("records 100 shared-source endpoints in two transactions using the actual receipt time", async () => {
		const f = evidenceRuntime();
		store.confirmStudy(f.scope, config);
		enroll(f.scope);
		const template = store.list(f.scope)[0];
		store.storage.transact((state) => {
			state.turns = Array.from({ length: 100 }, () => ({
				...structuredClone(template),
				id: randomUUID(),
				claims: template.claims.map((entry) => ({ ...structuredClone(entry), id: randomUUID() })),
			}));
		});
		advance(60_000);
		const receivedAt = new Date(now).toISOString();
		const complete = store.completeOutcomes.bind(store);
		vi.spyOn(store, "completeOutcomes").mockImplementation((inputs) => {
			advance(90_000);
			return complete(inputs);
		});
		const writes = vi.spyOn(store.storage, "transact");
		const result = await new DecisionOutcomeCollector(
			store,
			() => f.runtime,
			() => now,
		).collect();
		expect(result).toMatchObject({ requests: 1, observed: 100, missing: 0 });
		expect(writes).toHaveBeenCalledTimes(2);
		expect(store.evidence(f.scope).outcomes!.every((outcome) => outcome.endpoint?.at === receivedAt)).toBe(true);
		expect(f.placeOrder).not.toHaveBeenCalled();
	}, 30_000);
	it("leaves downtime missing instead of using a later price or revised endpoint", async () => {
		const f = evidenceRuntime();
		store.confirmStudy(f.scope, config);
		enroll(f.scope);
		advance(80_001);
		const collector = new DecisionOutcomeCollector(
			new DecisionStore(root, () => now),
			() => f.runtime,
			() => now,
		);
		expect(await collector.collect()).toMatchObject({ missing: 1, requests: 0 });
		expect(store.evidence(f.scope).outcomes![0]).toMatchObject({
			status: "missing",
			reason: "missed-endpoint-window",
		});
		expect(f.exchange.getTicker).not.toHaveBeenCalled();
	});
	it("does not let an expired backlog consume the current endpoint window after restart", async () => {
		const f = evidenceRuntime();
		store.confirmStudy(f.scope, config);
		enroll(f.scope);
		const expired = store.list(f.scope)[0];
		store.storage.transact((state) => {
			state.turns = Array.from({ length: 101 }, () => ({
				...structuredClone(expired),
				id: randomUUID(),
				claims: expired.claims.map((entry) => ({ ...structuredClone(entry), id: randomUUID() })),
			}));
		});
		advance(81_000);
		const current = enroll(f.scope);
		advance(60_000);
		const result = await new DecisionOutcomeCollector(
			store,
			() => f.runtime,
			() => now,
		).collect();
		expect(result).toMatchObject({ requests: 1, observed: 1, missing: 99 });
		expect(store.evidence(f.scope).outcomes!.find((entry) => entry.claimId === current.claimId)?.status).toBe(
			"observed",
		);
		expect(f.placeOrder).not.toHaveBeenCalled();
	}, 30_000);
	it.each(["future", "stale", "before-horizon", "missing-time", "wrong-symbol", "bad-price"] as const)(
		"rejects %s endpoint data and leaves explicit missingness",
		async (kind) => {
			const f = evidenceRuntime();
			store.confirmStudy(f.scope, config);
			enroll(f.scope);
			advance(60_000);
			const ticker: Ticker & { sourceTimestampKnown: boolean } = {
				sourceTimestampKnown: true,
				symbol: kind === "wrong-symbol" ? "ETH/USDT" : "BTC/USDT",
				last: kind === "bad-price" ? 0 : 110,
				timestamp:
					kind === "future"
						? now + 1
						: kind === "stale"
							? now - 30_001
							: kind === "before-horizon"
								? now - 1
								: kind === "missing-time"
									? Number.NaN
									: now,
			};
			vi.mocked(f.exchange.getTicker).mockResolvedValue(ticker);
			const result = await new DecisionOutcomeCollector(
				store,
				() => f.runtime,
				() => now,
			).collect();
			expect(result.observed).toBe(0);
			expect(result.issues).toHaveLength(1);
			expect(store.evidence(f.scope).outcomes ?? []).toHaveLength(0);
			expect(evaluateDecisions(store.evidence(f.scope)).strategy.cohorts[0]).toMatchObject({
				measuredSamples: 0,
				missingSamples: 1,
			});
		},
	);
	it("does not accept an in-flight endpoint after account switching or stopping the observer", async () => {
		const f = evidenceRuntime();
		store.confirmStudy(f.scope, config);
		enroll(f.scope);
		advance(60_000);
		let activeScope = f.scope;
		vi.mocked(f.exchange.getTicker).mockImplementation(async () => {
			activeScope = { ...f.scope, accountId: "other-account" };
			return { symbol: "BTC/USDT", last: 110, timestamp: now };
		});
		const collector = new DecisionOutcomeCollector(
			store,
			() => ({
				marketData: f.exchange,
				getExecutionScope: () => activeScope,
			}),
			() => now,
		);
		expect((await collector.collect()).issues[0]).toContain("scope-changed");
		expect(store.evidence(f.scope).outcomes ?? []).toHaveLength(0);
		collector.stop();
		expect(await collector.collect()).toMatchObject({ observed: 0, requests: 0 });
	});
	it("reports sanitized provider errors and retries only inside the original window", async () => {
		const f = evidenceRuntime();
		store.confirmStudy(f.scope, config);
		enroll(f.scope);
		advance(60_000);
		const collector = new DecisionOutcomeCollector(
			store,
			() => f.runtime,
			() => now,
		);
		vi.mocked(f.exchange.getTicker).mockRejectedValueOnce(new Error("socket disconnected SECRET-KEY"));
		expect((await collector.collect()).issues[0]).toContain("provider-disconnected");
		expect(await collector.collect()).toMatchObject({ requests: 0 });
		expect(readFileSync(store.storage.path, "utf8")).not.toContain("SECRET");
		advance(5000);
		expect(await collector.collect()).toMatchObject({ observed: 1, requests: 1 });
		expect(store.evidence(f.scope).attempts![0].count).toBe(2);
	});
	it("does not turn adapter-generated fallback timestamps into source-observed evidence", async () => {
		const f = evidenceRuntime();
		store.confirmStudy(f.scope, config);
		enroll(f.scope);
		advance(60_000);
		vi.mocked(f.exchange.getTicker).mockResolvedValue({ symbol: "BTC/USDT", last: 110, timestamp: now });
		const report = await new DecisionOutcomeCollector(
			store,
			() => f.runtime,
			() => now,
		).collect();
		expect(report.issues[0]).toContain("source-time-provenance-unavailable");
		expect(report.observed).toBe(0);
	});
	it("bounds hanging provider reads and exposes their timeout", async () => {
		const f = evidenceRuntime();
		store.confirmStudy(f.scope, config);
		enroll(f.scope);
		advance(60_000);
		vi.useFakeTimers();
		vi.mocked(f.exchange.getTicker).mockImplementation(() => new Promise<Ticker>(() => {}));
		const pending = new DecisionOutcomeCollector(
			store,
			() => f.runtime,
			() => now,
		).collect();
		await vi.advanceTimersByTimeAsync(10_000);
		const report = await pending;
		expect(report.issues[0]).toContain("provider-timeout");
		expect(report.observed).toBe(0);
	});
	it("invalidates pending samples after a Paper reset but not after an ordinary restart", async () => {
		const f = evidenceRuntime();
		store.confirmStudy(f.scope, config, 0);
		enroll(f.scope);
		const collector = new DecisionOutcomeCollector(
			store,
			() => ({
				marketData: f.exchange,
				getExecutionScope: () => f.scope,
				getEpoch: () => 1,
			}),
			() => now,
		);
		expect((await collector.collect()).issues).toContain("paper-reset-invalidated-study");
		const evidence = new DecisionStore(root).evidence(f.scope);
		expect(evidence.studies![0].stoppedAt).toBeDefined();
		expect(evidence.outcomes![0].reason).toBe("paper-reset-invalidated-study");
		expect(f.exchange.getTicker).not.toHaveBeenCalled();
		const next = store.confirmStudy(f.scope, config, 1);
		expect(next.epoch).toBe(1);
	});
});

describe("deterministic counterfactual cohorts, not realized account PnL", () => {
	it("computes declared-cost cash/buy-and-hold comparisons and directional samples but keeps small cohorts insufficient", async () => {
		const f = evidenceRuntime();
		store.confirmStudy(f.scope, config);
		enroll(f.scope);
		enroll(f.scope, { ...claim, action: "wait", forecast: { direction: "down" } });
		advance(60_000);
		vi.mocked(f.exchange.getTicker).mockResolvedValue(observedTicker(110));
		await new DecisionOutcomeCollector(
			store,
			() => f.runtime,
			() => now,
		).collect();
		const evidence = store.evidence(f.scope);
		const report = evaluateDecisions(evidence, now);
		const long = report.strategy.cohorts.find((cohort) => cohort.action === "enter")!;
		const cash = report.strategy.cohorts.find((cohort) => cohort.action === "wait")!;
		const expected = (110 * 0.9995 * 0.999) / (100 * 1.0005 * 1.001) - 1;
		expect(long.meanStrategyReturn).toBeCloseTo(expected);
		expect(long.meanExcessVsBuyAndHold).toBe(0);
		expect(cash.meanStrategyReturn).toBe(0);
		expect(cash.meanExcessVsBuyAndHold).toBeCloseTo(-expected);
		expect(long.forecastAccuracy).toBe(1);
		expect(cash.forecastAccuracy).toBe(0);
		expect(report.strategy.status).toBe("insufficient_evidence");
		expect(report.strategy.netReturn).toBeNull();
		expect(evaluateDecisions({ ...evidence, turns: [...evidence.turns].reverse() }, now)).toEqual(report);
	});
	it.each(["hold", "reduce", "exit"] as const)(
		"keeps unsupported %s comparisons null rather than zero",
		async (action) => {
			const f = evidenceRuntime();
			store.confirmStudy(f.scope, config);
			enroll(f.scope, { ...claim, action });
			advance(60_000);
			await new DecisionOutcomeCollector(
				store,
				() => f.runtime,
				() => now,
			).collect();
			const cohort = evaluateDecisions(store.evidence(f.scope)).strategy.cohorts[0];
			expect(cohort.meanStrategyReturn).toBeNull();
			expect(cohort.sampleResults[0].gaps).toContain("hold-reduce-exit-require-attributable-starting-inventory");
		},
	);
	it("never infers long exposure from persuasive free text", async () => {
		const f = evidenceRuntime();
		store.confirmStudy(f.scope, config);
		enroll(f.scope, { ...claim, forecast: undefined, rationale: "BUY LONG STRONG UPTREND" });
		advance(60_000);
		await new DecisionOutcomeCollector(
			store,
			() => f.runtime,
			() => now,
		).collect();
		expect(evaluateDecisions(store.evidence(f.scope)).strategy.cohorts[0].sampleResults[0].gaps).toContain(
			"missing-explicit-long-forecast",
		);
	});
	it("reports sufficiently many complete non-overlapping samples as descriptive only, never trustworthy", async () => {
		const f = evidenceRuntime();
		store.confirmStudy(f.scope, config);
		const collector = new DecisionOutcomeCollector(
			store,
			() => f.runtime,
			() => now,
		);
		for (let index = 0; index < 20; index++) {
			enroll(f.scope);
			advance(60_000);
			await collector.collect();
			advance(21_000);
		}
		const report = evaluateDecisions(store.evidence(f.scope)).strategy;
		expect(report.status).toBe("descriptive_evidence_only");
		expect(report.cohorts[0]).toMatchObject({
			samples: 20,
			measuredSamples: 20,
			nonOverlappingSamples: 20,
			missingSamples: 0,
		});
		expect(report.netReturn).toBeNull();
		const unrecorded = store.start(f.scope, "fixture", "model", fingerprint);
		store.finish(unrecorded, "finished");
		expect(evaluateDecisions(store.evidence(f.scope)).strategy.status).toBe("insufficient_evidence");
	}, 30_000);
});

describe("actual execution facts are not counterfactual assumptions", () => {
	function executionFixture() {
		const f = evidenceRuntime();
		const turnId = store.start(f.scope, "fixture", "model", fingerprint);
		const claimId = store.record(turnId, claim);
		store.update(turnId, (turn) =>
			turn.mutations.push({
				id: "mutation",
				tool: "buy",
				symbol: "BTC/USDT",
				at: new Date(now).toISOString(),
				decisionIds: [claimId],
				outcome: "request-completed",
				executionId: "execution",
			}),
		);
		store.finish(turnId, "finished");
		const record: ExecutionRecord = {
			id: "execution",
			scope: f.scope,
			intent: { kind: "order", input: { symbol: "BTC/USDT", side: "buy", type: "market", amount: 1 } },
			notional: 100,
			status: "acknowledged",
			revision: 1,
			createdAt: new Date(now).toISOString(),
			updatedAt: new Date(now).toISOString(),
			attempts: 0,
			evidence: {
				source: "submission",
				observedAt: new Date(now).toISOString(),
				fee: 0.1,
				orders: [
					{
						id: "native",
						symbol: "BTC/USDT",
						side: "buy",
						amount: 1,
						filled: 1,
						remaining: 0,
						cost: 100,
						status: "closed",
						feeObservation: {
							source: "paper-ledger",
							completeness: "complete",
							charges: [{ currency: "USDT", cost: 0.1 }],
						},
					},
				],
			},
		};
		return { scope: f.scope, record };
	}
	it("reports complete attributable fill and quote-fee facts without inventing a realized closed lot", () => {
		const { scope, record } = executionFixture();
		const report = evaluateActualExecutions(store.evidence(scope), [record], now);
		expect(report.completeFillAndFeeSamples).toBe(1);
		expect(report.rows[0]).toMatchObject({
			observedFilledNotional: 100,
			observedQuoteFee: 0.1,
			feeSource: "paper-ledger",
			realizedReturn: null,
		});
		expect(report.actualRealizedReturn).toBeNull();
	});
	it.each([0, -0.1])("preserves an explicitly observed fee or rebate of %s", (fee) => {
		const { scope, record } = executionFixture();
		record.evidence!.orders[0].feeObservation!.charges[0].cost = fee;
		const report = evaluateActualExecutions(store.evidence(scope), [record], now);
		expect(report.completeFillAndFeeSamples).toBe(1);
		expect(report.rows[0].observedQuoteFee).toBe(fee);
	});
	it.each(["legacy", "partial-fee", "foreign-currency", "wrong-source", "partial-fill", "future"] as const)(
		"does not upgrade %s evidence into complete observed costs",
		(kind) => {
			const { scope, record } = executionFixture();
			const order = record.evidence!.orders[0];
			if (kind === "legacy") delete order.feeObservation;
			if (kind === "partial-fee") order.feeObservation!.completeness = "partial";
			if (kind === "foreign-currency") order.feeObservation!.charges[0].currency = "BNB";
			if (kind === "wrong-source") order.feeObservation!.source = "exchange";
			if (kind === "partial-fill") order.filled = 0.5;
			if (kind === "future") record.evidence!.observedAt = new Date(now + 1).toISOString();
			const report = evaluateActualExecutions(store.evidence(scope), [record], now);
			expect(report.completeFillAndFeeSamples).toBe(0);
			expect(report.rows[0].observedQuoteFee).toBeNull();
			expect(report.rows[0].realizedReturn).toBeNull();
		},
	);
});

describe("decision commands and lifecycle", () => {
	it("runs the command, observation, public claim, collector, evaluation and shutdown path without a model or exchange", async () => {
		const f = evidenceRuntime();
		const h = evidenceExtensionHarness();
		h.ctx.model = {
			id: "fixture",
			name: "fixture",
			provider: "fixture",
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1000,
		};
		h.api.getActiveTools = () => [...h.tools.keys(), "get_price"];
		h.api.getAllTools = () => [
			...[...h.tools.values()].map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				sourceInfo: { path: "fixture", source: "fixture", scope: "project" as const, origin: "top-level" as const },
			})),
			{
				name: "get_price",
				description: "ticker",
				parameters: { type: "object" },
				sourceInfo: { path: "fixture", source: "fixture", scope: "project", origin: "top-level" },
			},
		];
		createDecisionEvidenceExtension(() => f.runtime, store, "fixture")(h.api);
		const command = h.commands.get("decisions")!;
		await command.handler(`study create ${JSON.stringify(config)}`, h.ctx);
		await h.emit("session_start");
		await h.emit("before_agent_start", { systemPrompt: "fixture" });
		await h.emit("tool_call", { toolName: "get_price", toolCallId: "entry-read", input: { symbol: "BTC/USDT" } });
		await h.emit("tool_result", {
			toolName: "get_price",
			toolCallId: "entry-read",
			input: { symbol: "BTC/USDT" },
			isError: false,
			...(await createGetPriceTool(() => f.runtime).execute(
				"entry-read",
				{ symbol: "BTC/USDT" },
				undefined,
				undefined,
				h.ctx,
			)),
		});
		const entry = store.list(f.scope)[0].observations[0];
		await h.tools
			.get("record_decision")!
			.execute("claim", { ...claim, observations: [entry.id] }, undefined, undefined, h.ctx);
		await h.emit("agent_end", { messages: [] });
		advance(60_000);
		await command.handler("collect", h.ctx);
		const result = await h.tools
			.get("get_decision_evaluation")!
			.execute("evaluation", { section: "strategy" }, undefined, undefined, h.ctx);
		expect(result.details).toMatchObject({ items: [{ measuredSamples: 1, missingSamples: 0 }] });
		const turn = store.list(f.scope)[0];
		h.confirm.mockResolvedValueOnce(true);
		await expect(command.handler(`delete ${turn.id}`, h.ctx)).rejects.toThrow(/bias/);
		const protocol = store.evidence(f.scope).studies![0];
		await command.handler(`study stop ${protocol.id}`, h.ctx);
		expect(store.evidence(f.scope).studies![0].stoppedAt).toBeDefined();
		await h.emit("session_shutdown");
		expect(f.placeOrder).not.toHaveBeenCalled();
		expect(h.sendMessage).not.toHaveBeenCalled();
		expect(h.appendEntry).toHaveBeenCalled();
	});
	it.each([false, undefined])("does not enroll a get_price source with provenance %s", async (known) => {
		const f = evidenceRuntime();
		vi.mocked(f.exchange.getTicker).mockResolvedValue({ ...observedTicker(), sourceTimestampKnown: known });
		store.confirmStudy(f.scope, config);
		const h = evidenceExtensionHarness();
		createDecisionEvidenceExtension(() => f.runtime, store)(h.api);
		await h.emit("before_agent_start", { systemPrompt: "fixture" });
		const input = { symbol: "BTC/USDT" };
		await h.emit("tool_call", { toolName: "get_price", toolCallId: "entry", input });
		const result = await createGetPriceTool(() => f.runtime).execute("entry", input, undefined, undefined, h.ctx);
		expect(result.details).toMatchObject({ sourceTimestampKnown: false });
		await h.emit("tool_result", { toolName: "get_price", toolCallId: "entry", input, isError: false, ...result });
		const source = store.list(f.scope)[0].observations[0];
		await h.tools
			.get("record_decision")!
			.execute("claim", { ...claim, observations: [source.id] }, undefined, undefined, h.ctx);
		await h.emit("agent_end", { messages: [] });
		expect(store.evidence(f.scope).outcomes![0].reason).toBe("missing-trusted-prospective-entry");
		expect(f.placeOrder).not.toHaveBeenCalled();
	});
	it("paginates every sample and turn without sending operator output into model history", async () => {
		const f = evidenceRuntime();
		enroll(f.scope);
		const template = store.list(f.scope)[0];
		store.storage.transact((state) => {
			state.turns = Array.from({ length: 80 }, () => ({
				...structuredClone(template),
				id: randomUUID(),
				claims: template.claims.map((entry) => ({ ...structuredClone(entry), id: randomUUID() })),
			}));
		});
		const h = evidenceExtensionHarness();
		createDecisionEvidenceExtension(() => f.runtime, store)(h.api);
		const evaluation = {
			...evaluateDecisions(store.evidence(f.scope)),
			actualExecution: evaluateActualExecutions(store.evidence(f.scope), []),
		};
		const overview = decisionEvaluationPage(evaluation);
		expect(overview).toMatchObject({ counts: { samples: 80 } });
		expect(JSON.stringify(overview)).not.toContain("sampleResults");
		expect(Buffer.byteLength(JSON.stringify(overview))).toBeLessThan(8192);
		let offset: number | null = 0;
		let count = 0;
		while (offset !== null) {
			const page = decisionEvaluationPage(evaluation, "samples", offset);
			if (!("items" in page)) throw new Error("Expected a sample page");
			expect(Buffer.byteLength(JSON.stringify(page.items))).toBeLessThan(16_500);
			count += page.items.length;
			offset = page.nextOffset;
		}
		expect(count).toBe(80);
		const command = h.commands.get("decisions")!;
		for (const args of ["list 20", "evaluate strategy", "evaluate samples 20"]) {
			await command.handler(args, h.ctx);
		}
		await command.handler(`show ${store.list(f.scope)[0].id} 0`, h.ctx);
		expect(h.appendEntry).toHaveBeenCalledTimes(4);
		expect(h.sendMessage).not.toHaveBeenCalled();
		await command.handler("export", h.ctx);
		const exported = JSON.parse(readFileSync(h.notify.mock.calls.at(-1)![0] as string, "utf8"));
		expect(exported.evidence.turns).toHaveLength(80);
		expect(evaluateDecisions(exported.evidence).strategy.cohorts[0].samples).toBe(80);
	});
	it("allows bounded export overhead without increasing the active store capacity", () => {
		const privateStore = new PrivateStore<unknown>(
			join(root, "tiny.json"),
			() => null,
			(_value): asserts _value is unknown => {},
			128,
		);
		const data = { value: "x".repeat(150) };
		expect(() => privateStore.export("default", data)).toThrow(/limit/);
		const path = privateStore.export("with-overhead", data, 256);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(data);
		expect(() => privateStore.export("unbounded", data, 513)).toThrow(/capacity/);
	});
	it("requires operator confirmation, never exposes a configuration tool, and exports frozen evidence/results", async () => {
		const f = evidenceRuntime();
		const h = evidenceExtensionHarness();
		createDecisionEvidenceExtension(() => f.runtime, store, "fixture")(h.api);
		const command = h.commands.get("decisions")!;
		h.confirm.mockResolvedValueOnce(false);
		await command.handler(`study create ${JSON.stringify(config)}`, h.ctx);
		expect(store.evidence(f.scope).studies ?? []).toHaveLength(0);
		await command.handler(`study create ${JSON.stringify(config)}`, h.ctx);
		const study = store.evidence(f.scope).studies![0];
		expect(study.confirmedBy).toBe("operator");
		expect([...h.tools.keys()].sort()).toEqual(["get_decision_evaluation", "record_decision"]);
		await command.handler("export", h.ctx);
		const path = h.notify.mock.calls.at(-1)![0] as string;
		const exported = JSON.parse(readFileSync(path, "utf8"));
		expect(exported.evidence.studies[0]).toEqual(study);
		expect(exported.evaluation.strategy.status).toBe("insufficient_evidence");
		expect(exported.evaluation.actualExecution.actualRealizedReturn).toBeNull();
		for (const call of h.sendMessage.mock.calls) expect(call[1]).toEqual({ triggerTurn: false });
		expect(f.placeOrder).not.toHaveBeenCalled();
		await h.emit("session_shutdown");
	});
	it("binds fingerprint to active tools only and marks incomplete or changed tools as incomplete capture", async () => {
		const f = evidenceRuntime();
		const h = evidenceExtensionHarness();
		let names = ["get_price"];
		h.api.getActiveTools = () => names;
		h.api.getAllTools = () => [
			{
				name: "get_price",
				description: "ticker",
				parameters: { type: "object" },
				sourceInfo: { path: "fixture", source: "fixture", scope: "project", origin: "top-level" },
			},
			{
				name: "buy",
				description: "mutating",
				parameters: { type: "object" },
				sourceInfo: { path: "fixture", source: "fixture", scope: "project", origin: "top-level" },
			},
		];
		createDecisionEvidenceExtension(() => f.runtime, store, "fixture")(h.api);
		await h.emit("before_agent_start", { systemPrompt: "p" });
		expect(store.list(f.scope)[0].fingerprint).toBe(
			evidenceFingerprint(
				"p",
				[{ name: "get_price", parameters: { type: "object" }, description: "ticker", promptGuidelines: null }],
				"fixture",
			),
		);
		names = ["get_price", "buy"];
		await h.emit("tool_call", { toolName: "buy", toolCallId: "changed", input: { symbol: "BTC/USDT" } });
		await h.emit("agent_end", { messages: [] });
		expect(store.list(f.scope)[0].captureComplete).toBe(false);
	});
	it("rejects crossed scope, invalid and future tool source times without throwing or accepting them", async () => {
		const f = evidenceRuntime();
		const h = evidenceExtensionHarness();
		createDecisionEvidenceExtension(() => f.runtime, store)(h.api);
		await h.emit("before_agent_start", { systemPrompt: "p" });
		for (const details of [
			{ last: 100, time: "2026-02-31T00:00:00.000Z" },
			{ last: 100, time: new Date(now + 1).toISOString() },
			{ last: 100, time: new Date(now).toISOString(), mode: "live" },
		]) {
			const toolCallId = randomUUID();
			await h.emit("tool_call", { toolName: "get_price", toolCallId, input: { symbol: "BTC/USDT" } });
			await h.emit("tool_result", {
				toolName: "get_price",
				toolCallId,
				input: { symbol: "BTC/USDT" },
				isError: false,
				content: [],
				details,
			});
		}
		expect(store.list(f.scope)[0].observations.every((observation) => observation.status === "partial")).toBe(true);
		await h.emit("agent_end", { messages: [] });
		expect(h.notify).not.toHaveBeenCalled();
	});
});
