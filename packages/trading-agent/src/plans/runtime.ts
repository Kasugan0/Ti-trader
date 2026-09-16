import type { ExecutionRecord, ExecutionScope, MarketDataClient } from "@nikopack/ti-trading-engine";
import { boundedLookup, observedExecutionFee } from "@nikopack/ti-trading-engine";
import { evaluateCondition, type FactSnapshot } from "@nikopack/ti-triggers";
import type { TradingRuntime } from "../context.ts";
import { failureCode } from "../failure-code.ts";
import { observePlanAccounts, type PlanEvidenceReader } from "./account-observations.ts";
import { comparePlanExecutions } from "./comparisons.ts";
import { PLAN_MAX_AGE_MS, type PlanContent, type PlanObservation, type TradePlan } from "./model.ts";
import { PlanStore, planScopeKey } from "./store.ts";

export { getPlanStore, markPaperReset } from "./store.ts";

export interface PlanReference {
	id: string;
	version: number;
	intentId: string;
}
export interface PlanSubmission {
	intent: ExecutionRecord["intent"];
	countTowardsDailyLimit: boolean;
	protectionStopPrice?: number;
	referencePrice?: number;
	referenceTimestamp?: number;
}
export type PlanRuntime = Pick<TradingRuntime, "tradingEngine" | "config" | "mode">;
export function getPlanContext(
	trading: PlanRuntime,
	store = new PlanStore(),
): { scope: ExecutionScope; generation: number } {
	const scope = trading.tradingEngine.getExecutionScope();
	return { scope, generation: store.epoch(scope) };
}

const periods: Record<string, number> = {
	"1m": 60_000,
	"5m": 300_000,
	"15m": 900_000,
	"1h": 3_600_000,
	"4h": 14_400_000,
	"1d": 86_400_000,
};

export function validatePlanSubmission(
	trading: PlanRuntime,
	reference: PlanReference,
	submission: PlanSubmission,
	store = new PlanStore(),
	now = Date.now(),
): TradePlan {
	if (
		!/^[A-Za-z0-9_-]{1,80}$/.test(reference.id) ||
		!Number.isSafeInteger(reference.version) ||
		reference.version < 1 ||
		!/^[A-Za-z0-9_-]{1,80}$/.test(reference.intentId)
	)
		throw new Error("Invalid plan reference");
	const { scope, generation } = getPlanContext(trading, store);
	const executionStatus = trading.tradingEngine.getExecutionStatus();
	if (executionStatus.staleRuntime || executionStatus.maintenance)
		throw new Error("Trading runtime changed or account maintenance is active");
	const plan = store.read(reference.id, scope);
	const version = plan.versions[reference.version - 1];
	if (!version || !plan.events.some((event) => event.kind === "activated" && event.version === reference.version))
		throw new Error("Plan version has not been activated by the operator");
	if (version.epoch !== generation) throw new Error("Plan belongs to a reset Paper account");
	if (version.content.symbol !== submission.intent.input.symbol)
		throw new Error("Order symbol differs from the plan version");
	if (submission.countTowardsDailyLimit) {
		if (plan.status !== "tracking" || plan.activeVersion !== reference.version)
			throw new Error("Opening requires the current tracked plan version");
		if (Date.parse(version.content.expiresAt) <= now)
			throw new Error("Plan expired; revise and confirm before opening");
		if (
			version.content.direction === "observe" ||
			(version.content.direction === "long" ? "buy" : "sell") !== submission.intent.input.side
		)
			throw new Error("Order direction differs from the plan");
		const observation = plan.observation;
		if (
			!observation ||
			observation.version !== reference.version ||
			Date.parse(observation.at) > now ||
			now - Date.parse(observation.at) > PLAN_MAX_AGE_MS ||
			observation.expired ||
			observation.entry !== "true" ||
			observation.invalidation !== "false"
		)
			throw new Error("Plan entry or invalidation is unsatisfied, unknown or stale; refresh /plan review");
		// Re-evaluate source timestamps, not just the time at which a cached summary was written.
		const evaluated = evaluatePlan(
			version.content,
			reference.version,
			Object.fromEntries(
				observation.facts.map((fact) => [fact.fact, { value: fact.value, observedAt: fact.observedAt }]),
			),
			now,
			[],
		);
		if (evaluated.entry !== "true" || evaluated.invalidation !== "false")
			throw new Error("Plan evidence is no longer fresh");
	}
	return plan;
}

export function preparePlanSubmission(
	trading: PlanRuntime,
	reference: PlanReference,
	submission: PlanSubmission,
	store = new PlanStore(),
): { intentId: string; reference: { kind: string; id: string; version: number }; validateReference: () => void } {
	validatePlanSubmission(trading, reference, submission, store);
	const intentId = store.saveIntent(
		reference.id,
		trading.tradingEngine.getExecutionScope(),
		reference.version,
		reference.intentId,
		submission,
	);
	return {
		intentId,
		reference: { kind: "trade-plan", id: reference.id, version: reference.version },
		validateReference: () => {
			validatePlanSubmission(trading, reference, submission, store);
		},
	};
}

export function archivePlanExecutions(trading: PlanRuntime, store = new PlanStore()): number {
	let count = 0;
	for (const record of trading.tradingEngine.listExecutions()) {
		if (record.reference?.kind !== "trade-plan" || record.archiveAcknowledgedRevision === record.revision) continue;
		store.archiveExecution(record);
		trading.tradingEngine.acknowledgeExecutionArchive(record.id, record.revision);
		count++;
	}
	return count;
}

function evaluatePlan(
	content: PlanContent,
	version: number,
	facts: FactSnapshot,
	now: number,
	limitations: string[],
): PlanObservation {
	const freshFacts = Object.fromEntries(
		Object.entries(facts).filter(
			([key, fact]) =>
				fact &&
				now - fact.observedAt <=
					(key === "closed_price" ? periods[content.timeframe] + PLAN_MAX_AGE_MS : PLAN_MAX_AGE_MS),
		),
	);
	const evaluate = (conditions: PlanContent["entry"], kind: "all" | "any") =>
		evaluateCondition(
			{
				kind,
				conditions: conditions.map((condition) => ({
					kind: "compare",
					fact: { key: condition.fact },
					operator: condition.operator,
					value: condition.value,
				})),
			},
			freshFacts,
			now,
			undefined,
			{ maxAgeMs: periods[content.timeframe] + PLAN_MAX_AGE_MS, futureToleranceMs: 0 },
		).state;
	return {
		version,
		at: new Date(now).toISOString(),
		entry: evaluate(content.entry, "all"),
		invalidation: evaluate(content.invalidation, "any"),
		expired: Date.parse(content.expiresAt) <= now,
		reviewDue: Date.parse(content.reviewAt) <= now,
		facts: (["price", "closed_price"] as const).flatMap((fact) => {
			const value = facts[fact];
			return value && typeof value.value === "number"
				? [{ fact, value: value.value, observedAt: value.observedAt }]
				: [];
		}),
		limitations,
	};
}

export class PlanMonitor {
	private readonly store: PlanStore;
	private readonly now: () => number;
	private readonly baselines = new Set<string>();
	constructor(store = new PlanStore(), now: () => number = Date.now) {
		this.store = store;
		this.now = now;
	}
	resetBaseline(): void {
		this.baselines.clear();
	}
	async tick(
		scope: ExecutionScope,
		client: Pick<MarketDataClient, "getTicker" | "getKlines"> &
			Partial<Pick<MarketDataClient, "getPositions" | "getOpenOrders">>,
		isCurrent = () => true,
		options: { executions?: PlanEvidenceReader; protectionCoveragePct?: number } = {},
	): Promise<Array<{ plan: TradePlan; eventId: string }>> {
		const plans = this.store.list(scope).filter((plan) => plan.status === "tracking" && plan.activeVersion !== null);
		const tickers = new Map<string, Awaited<ReturnType<MarketDataClient["getTicker"]>> | string>();
		const candles = new Map<string, Awaited<ReturnType<MarketDataClient["getKlines"]>> | string>();
		for (const plan of plans) {
			if (!isCurrent()) return [];
			const content = plan.versions[plan.activeVersion! - 1].content;
			if (!tickers.has(content.symbol)) {
				try {
					tickers.set(content.symbol, await boundedLookup(() => client.getTicker(content.symbol), 1500));
				} catch (error) {
					tickers.set(content.symbol, failureCode(error));
				}
			}
			const key = `${content.symbol}:${content.timeframe}`;
			if (
				[...content.entry, ...content.invalidation].some((condition) => condition.fact === "closed_price") &&
				!candles.has(key)
			) {
				try {
					candles.set(
						key,
						await boundedLookup(() => client.getKlines(content.symbol, content.timeframe, 3), 1500),
					);
				} catch (error) {
					candles.set(key, failureCode(error));
				}
			}
		}
		if (!isCurrent()) return [];
		const result: Array<{ plan: TradePlan; eventId: string }> = [];
		const now = this.now();
		let failed = false;
		let observedAt: number | undefined;
		for (const plan of plans) {
			const content = plan.versions[plan.activeVersion! - 1].content;
			const facts: Record<string, { value: number; observedAt: number }> = {};
			const limitations: string[] = [];
			const ticker = tickers.get(content.symbol);
			if (
				ticker &&
				typeof ticker !== "string" &&
				ticker.sourceTimestampKnown === true &&
				ticker.symbol === content.symbol &&
				ticker.last !== undefined &&
				Number.isFinite(ticker.last) &&
				ticker.last > 0 &&
				Number.isFinite(ticker.timestamp) &&
				ticker.timestamp > 0 &&
				ticker.timestamp <= now &&
				now - ticker.timestamp <= PLAN_MAX_AGE_MS
			) {
				facts.price = { value: ticker.last, observedAt: ticker.timestamp };
			} else limitations.push("Current price unavailable, stale, invalid or without source timestamp provenance");
			const rows = candles.get(`${content.symbol}:${content.timeframe}`);
			if (Array.isArray(rows)) {
				const closed = rows
					.filter(
						(row) =>
							row.closed !== false &&
							Number.isFinite(row.timestamp) &&
							row.timestamp > 0 &&
							row.timestamp + periods[content.timeframe] <= now &&
							row.close > 0 &&
							Number.isFinite(row.close),
					)
					.sort((a, b) => b.timestamp - a.timestamp)[0];
				if (closed)
					facts.closed_price = { value: closed.close, observedAt: closed.timestamp + periods[content.timeframe] };
			}
			if (
				[...content.entry, ...content.invalidation].some((condition) => condition.fact === "closed_price") &&
				!facts.closed_price
			)
				limitations.push("Closed candle unavailable");
			const observation = evaluatePlan(content, plan.activeVersion!, facts, now, limitations);
			failed ||= observation.entry === "unknown" || observation.invalidation === "unknown";
			for (const fact of observation.facts)
				if (fact.observedAt <= now && now - fact.observedAt <= PLAN_MAX_AGE_MS)
					observedAt = Math.max(observedAt ?? 0, fact.observedAt);
			const baselineKey = `${planScopeKey(scope)}:${plan.id}:${observation.version}`;
			const eventId = this.store.observe(plan.id, scope, observation, !this.baselines.has(baselineKey));
			this.baselines.add(baselineKey);
			if (eventId) result.push({ plan: this.store.read(plan.id, scope), eventId });
		}
		const accounts = await observePlanAccounts(
			this.store,
			plans,
			scope,
			client,
			options.executions,
			isCurrent,
			this.now,
			options.protectionCoveragePct,
		);
		if (!isCurrent()) return [];
		for (const [id, account] of accounts) {
			failed ||= account.observation.status === "unknown";
			if (account.eventId) {
				const existing = result.find((entry) => entry.plan.id === id);
				if (existing) {
					existing.plan = this.store.read(id, scope);
					existing.eventId = account.eventId;
				} else result.push({ plan: this.store.read(id, scope), eventId: account.eventId });
			}
		}
		if (plans.length) this.store.recordMonitorHealth(scope, observedAt, failed);
		return result;
	}
}

export function planIndex(store: PlanStore, scope: ExecutionScope, now = Date.now(), cached = false): string {
	const lines = [
		"Saved plans are non-authoritative research. Recheck current account facts. Use read_plan for details.",
	];
	const plans = store.list(scope).filter((plan) => plan.status !== "archived");
	for (const plan of plans) {
		const content = plan.versions[(plan.activeVersion ?? plan.versions.length) - 1].content;
		const age = !cached && plan.observation ? now - Date.parse(plan.observation.at) : Number.POSITIVE_INFINITY;
		const line = `${plan.id} v${plan.activeVersion ?? plan.versions.length} ${plan.status} ${content.symbol} updated=${plan.versions[(plan.activeVersion ?? plan.versions.length) - 1].at} draft=v${plan.versions.length} ${Date.parse(content.expiresAt) <= now ? "EXPIRED" : ""} review=${content.reviewAt} observations=${age >= 0 && age <= PLAN_MAX_AGE_MS ? "recent; verify source timestamps" : "unknown/stale"}`;
		if (Buffer.byteLength([...lines, line, "More plans omitted; call list_plans."].join("\n"), "utf8") > 4096) {
			lines.push("More plans omitted; call list_plans.");
			break;
		}
		lines.push(line);
	}
	if (!plans.length) lines.push("No active plans in this account scope.");
	return lines.join("\n");
}

export function reviewPlan(plan: TradePlan, now = Date.now()) {
	const latest = new Map<string, TradePlan["executions"][number]>();
	for (const entry of plan.executions)
		if ((latest.get(entry.record.id)?.record.revision ?? 0) <= entry.record.revision)
			latest.set(entry.record.id, entry);
	const executions = [...latest.values()];
	const gaps: string[] = [];
	if (!executions.length) gaps.push("No correlated execution evidence");
	if (plan.scope.marketType !== "spot") gaps.push("Futures funding and liquidation costs are not complete");
	let cashFlow = 0;
	let quantity = 0;
	let filledOrders = 0;
	for (const { record } of executions.sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt))) {
		const fee = observedExecutionFee(record);
		if (record.status === "unknown" || record.status === "submission-started" || record.status === "prepared")
			gaps.push(`Unresolved execution ${record.id}`);
		if (record.evidence?.source === "operator" || (!record.evidence && record.settlement?.outcome !== "release"))
			gaps.push(`Fill-level evidence unavailable for ${record.id}`);
		if (fee === undefined && record.evidence?.orders.some((order) => order.filled > 0))
			gaps.push(`Unknown fees for ${record.id}`);
		if (fee !== undefined) cashFlow -= fee;
		for (const order of record.evidence?.orders ?? []) {
			if (order.filled > 0) filledOrders++;
			if (order.status === "open" || order.status === "unknown") gaps.push(`Order ${order.id} is not terminal`);
			if (order.filled > 0 && !(order.cost > 0)) gaps.push(`Fill cost unavailable for ${order.id}`);
			quantity += (order.side === "buy" ? 1 : -1) * order.filled;
			cashFlow += (order.side === "sell" ? 1 : -1) * order.cost;
			if (quantity < -1e-8) gaps.push("Exit cannot be attributed entirely to preceding plan entries");
		}
	}
	if (!filledOrders) gaps.push("No attributed fills; no trading-result evidence");
	if (!Number.isFinite(cashFlow) || !Number.isFinite(quantity))
		gaps.push("Non-finite aggregate cash flow or quantity");
	if (Math.abs(quantity) > 1e-8) gaps.push("Plan still has unmatched filled quantity; no complete round-trip result");
	return {
		id: plan.id,
		scope: plan.scope,
		status: plan.status,
		activeVersion: plan.activeVersion,
		versions: plan.versions,
		notes: plan.notes,
		observation: plan.observation ?? null,
		observationFresh:
			plan.observation !== undefined &&
			Date.parse(plan.observation.at) <= now &&
			now - Date.parse(plan.observation.at) <= PLAN_MAX_AGE_MS,
		accountObservation: plan.accountObservation ?? null,
		accountObservationFresh:
			plan.accountObservation !== undefined &&
			Date.parse(plan.accountObservation.at) <= now &&
			now - Date.parse(plan.accountObservation.at) <= PLAN_MAX_AGE_MS,
		events: plan.events,
		executions,
		differences: comparePlanExecutions(plan, executions),
		result: {
			status: gaps.length ? "insufficient_evidence" : "complete_paper_or_recorded_cash_flow",
			netQuoteCashFlow: gaps.length ? null : cashFlow,
			gaps: [...new Set(gaps)],
		},
		limitations: [
			"Research notes are model claims, not current account facts.",
			"Only correlated orders are included; same-symbol holdings and outside trades are not assigned to this plan.",
			"Cash flow is not strategy profitability or future-return evidence. Fees absent from the adapter remain unknown.",
		],
	};
}
