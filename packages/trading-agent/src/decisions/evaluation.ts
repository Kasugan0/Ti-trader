import { type ExecutionRecord, observedExecutionFee } from "@nikopack/ti-trading-engine";
import { canonicalTime, sameScope } from "../plans/model.ts";
import type { DecisionEvidence, DecisionTurn } from "./evidence.ts";
import type { DecisionStudy } from "./protocol.ts";

type Sample = ReturnType<typeof evaluateSample>;
function evaluateSample(
	turn: DecisionTurn,
	claim: DecisionTurn["claims"][number],
	study: DecisionStudy | undefined,
	outcome: NonNullable<DecisionEvidence["outcomes"]>[number] | undefined,
	attempt: NonNullable<DecisionEvidence["attempts"]>[number] | undefined,
	now: number,
) {
	const enrollment = claim.evaluation;
	const source = turn.observations.find((entry) => entry.id === enrollment?.entryObservationId);
	const gaps: string[] = [];
	if (!study || !enrollment) gaps.push("no-prospective-operator-protocol");
	if (
		!turn.captureComplete ||
		turn.activeToolsComplete === false ||
		turn.provider === "unavailable" ||
		turn.model === "unavailable"
	)
		gaps.push("incomplete-turn-capture");
	if (turn.status !== "finished") gaps.push("turn-not-finished");
	if (!claim.beforeMutation) gaps.push("retrospective-claim");
	if (enrollment?.gap) gaps.push(enrollment.gap);
	if (outcome?.reason) gaps.push(outcome.reason);
	if (enrollment && !outcome) {
		gaps.push(now > Date.parse(enrollment.deadlineAt) ? "missed-endpoint-window" : "endpoint-pending");
		if (attempt) gaps.push(`collector-${attempt.reason}`);
	}
	if (turn.scope.marketType !== "spot" || claim.claim.symbol?.includes(":"))
		gaps.push("futures-carry-leverage-and-liquidation-unsupported");
	let exposure: "long" | "cash" | undefined;
	if (["wait", "avoid"].includes(claim.claim.action)) exposure = "cash";
	else if (claim.claim.action === "enter" && claim.claim.forecast?.direction === "up") exposure = "long";
	else if (claim.claim.action === "enter")
		gaps.push(
			claim.claim.forecast?.direction === "down" ? "short-exposure-unsupported" : "missing-explicit-long-forecast",
		);
	else gaps.push("hold-reduce-exit-require-attributable-starting-inventory");
	const entryPrice = source?.snapshot.last;
	const endpointPrice = outcome?.endpoint?.price;
	let grossMarketReturn: number | null = null;
	let strategyReturn: number | null = null;
	let buyAndHoldReturn: number | null = null;
	let cashReturn: number | null = null;
	let forecastCorrect: boolean | null = null;
	if (study && typeof entryPrice === "number" && endpointPrice !== undefined && !gaps.length && exposure) {
		const ratio = endpointPrice / entryPrice;
		const fee = study.config.feeBpsPerSide / 10_000;
		const slippage = study.config.slippageBpsPerSide / 10_000;
		if (!Number.isFinite(ratio)) gaps.push("non-finite-benchmark-result");
		else {
			grossMarketReturn = ratio - 1;
			buyAndHoldReturn = ratio * (((1 - slippage) * (1 - fee)) / ((1 + slippage) * (1 + fee))) - 1;
			cashReturn = 0;
			strategyReturn = exposure === "long" ? buyAndHoldReturn : cashReturn;
			if (claim.claim.forecast) {
				const realizedDirection = grossMarketReturn > 0 ? "up" : grossMarketReturn < 0 ? "down" : "flat";
				forecastCorrect = claim.claim.forecast.direction === realizedDirection;
			}
		}
	}
	return {
		turnId: turn.id,
		claimId: claim.id,
		at: claim.at,
		action: claim.claim.action,
		symbol: claim.claim.symbol ?? null,
		studyId: study?.id ?? null,
		dueAt: enrollment?.dueAt ?? null,
		deadlineAt: enrollment?.deadlineAt ?? null,
		entryObservationId: enrollment?.entryObservationId ?? null,
		entryPrice: typeof entryPrice === "number" ? entryPrice : null,
		entrySourceAt: source?.sourceAt ?? null,
		endpoint: outcome?.endpoint ?? null,
		status: strategyReturn === null ? "insufficient_evidence" : "observed_counterfactual",
		exposure: exposure ?? null,
		grossMarketReturn,
		strategyReturn,
		cashReturn,
		buyAndHoldReturn,
		excessVsCash: strategyReturn === null || cashReturn === null ? null : strategyReturn - cashReturn,
		excessVsBuyAndHold:
			strategyReturn === null || buyAndHoldReturn === null ? null : strategyReturn - buyAndHoldReturn,
		forecastDirection: claim.claim.forecast?.direction ?? null,
		forecastCorrect,
		collectionAttempts: attempt?.count ?? 0,
		gaps: [...new Set(gaps)].sort(),
	};
}

function summary(samples: Sample[], minimumSamples: number | undefined) {
	const measured = samples
		.filter((sample) => sample.strategyReturn !== null)
		.sort((a, b) => a.at.localeCompare(b.at) || a.claimId.localeCompare(b.claimId));
	const mean = (
		field: "strategyReturn" | "cashReturn" | "buyAndHoldReturn" | "excessVsCash" | "excessVsBuyAndHold",
	) =>
		measured.length ? measured.reduce((total, sample) => total + (sample[field] ?? 0) / measured.length, 0) : null;
	const gaps: Record<string, number> = {};
	for (const sample of samples) for (const gap of sample.gaps) gaps[gap] = (gaps[gap] ?? 0) + 1;
	const orderedGaps = Object.fromEntries(Object.entries(gaps).sort(([a], [b]) => a.localeCompare(b)));
	const forecasts = measured.filter((sample) => sample.forecastCorrect !== null);
	const days = new Set(measured.map((sample) => sample.at.slice(0, 10)));
	const ordered = [...measured].sort((a, b) => a.at.localeCompare(b.at) || a.claimId.localeCompare(b.claimId));
	let nonOverlapping = 0;
	let previousEnd = "";
	for (const sample of ordered) {
		if (sample.at >= previousEnd) {
			nonOverlapping++;
			previousEnd = sample.deadlineAt ?? sample.at;
		}
	}
	return {
		status:
			minimumSamples !== undefined &&
			measured.length >= minimumSamples &&
			nonOverlapping >= minimumSamples &&
			measured.length === samples.length
				? "descriptive_evidence_only"
				: "insufficient_evidence",
		samples: samples.length,
		measuredSamples: measured.length,
		missingSamples: samples.length - measured.length,
		missingFraction: samples.length ? (samples.length - measured.length) / samples.length : null,
		minimumSamples: minimumSamples ?? null,
		nonOverlappingSamples: nonOverlapping,
		observedUtcDays: days.size,
		meanStrategyReturn: mean("strategyReturn"),
		meanCashReturn: mean("cashReturn"),
		meanBuyAndHoldReturn: mean("buyAndHoldReturn"),
		meanExcessVsCash: mean("excessVsCash"),
		meanExcessVsBuyAndHold: mean("excessVsBuyAndHold"),
		forecastSamples: forecasts.length,
		correctForecasts: forecasts.filter((sample) => sample.forecastCorrect).length,
		forecastAccuracy: forecasts.length
			? forecasts.filter((sample) => sample.forecastCorrect).length / forecasts.length
			: null,
		gapCounts: orderedGaps,
	};
}

export function evaluateStrategy(evidence: DecisionEvidence, now: number) {
	const studies = new Map((evidence.studies ?? []).map((study) => [study.id, study]));
	const outcomes = new Map((evidence.outcomes ?? []).map((outcome) => [outcome.claimId, outcome]));
	const attempts = new Map((evidence.attempts ?? []).map((attempt) => [attempt.claimId, attempt]));
	const cohorts = new Map<
		string,
		{ turn: DecisionTurn; study?: DecisionStudy; samples: Sample[]; action: string; symbol: string | null }
	>();
	for (const turn of evidence.turns)
		for (const claim of turn.claims) {
			const study = claim.evaluation ? studies.get(claim.evaluation.studyId) : undefined;
			const scopeKey = Object.entries(turn.scope).sort(([a], [b]) => a.localeCompare(b));
			const key = JSON.stringify([
				scopeKey,
				turn.epoch ?? null,
				turn.provider,
				turn.model,
				turn.fingerprint,
				study?.id ?? null,
				claim.claim.action,
				claim.claim.symbol ?? null,
			]);
			let cohort = cohorts.get(key);
			if (!cohort) {
				cohort = { turn, study, samples: [], action: claim.claim.action, symbol: claim.claim.symbol ?? null };
				cohorts.set(key, cohort);
			}
			cohort.samples.push(evaluateSample(turn, claim, study, outcomes.get(claim.id), attempts.get(claim.id), now));
		}
	const reports = [...cohorts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, cohort]) => ({
			scope: cohort.turn.scope,
			epoch: cohort.turn.epoch ?? null,
			provider: cohort.turn.provider,
			model: cohort.turn.model,
			fingerprint: cohort.turn.fingerprint,
			studyId: cohort.study?.id ?? null,
			protocolDigest: cohort.study?.digest ?? null,
			action: cohort.action,
			symbol: cohort.symbol,
			horizonSeconds: cohort.study?.config.horizonSeconds ?? null,
			...summary(cohort.samples, cohort.study?.config.minimumSamples),
			sampleResults: cohort.samples.sort((a, b) => a.at.localeCompare(b.at) || a.claimId.localeCompare(b.claimId)),
		}));
	return {
		status:
			!reports.length ||
			evidence.turns.some((turn) => !turn.claims.length) ||
			reports.some((report) => report.status === "insufficient_evidence")
				? "insufficient_evidence"
				: "descriptive_evidence_only",
		// A mean of overlapping, unit-notional decisions is not an account equity curve.
		netReturn: null,
		returnUnits: "fraction",
		method: "prospective-fixed-horizon-unit-notional-spot-long-or-cash",
		cohorts: reports,
		protocols: [...studies.values()].sort((a, b) => a.id.localeCompare(b.id)),
		unrecordedTurns: evidence.turns.filter((turn) => !turn.claims.length).length,
		gaps: [
			...(studies.size ? [] : ["No operator-confirmed prospective protocol"]),
			"Counterfactual returns use declared costs, never adapter-observed fees.",
			"Actual account PnL requires attributable closed lots and complete observed costs.",
			"Overlapping decisions, selective recording and market regimes prevent causal or model-trust conclusions.",
		],
		limitations: [
			"Cash means zero-yield quote currency; no interest, staking yield or fiat purchasing-power adjustment.",
			"Buy-and-hold enters and exits at bounded ticker references with both sides of declared fees and slippage.",
			"Long enter decisions follow the identical unit-notional buy-and-hold rule; they cannot establish superior timing within the horizon.",
			"Hold, reduce, exit and futures are unsupported without attributable inventory, carry and leverage facts.",
			"Free-text rationale, invalidation and horizon are claims, not machine-evaluated conditions; study numeric horizon controls evaluation.",
			"No confidence interval, significance, independence, market-regime coverage or trading permission is established.",
		],
	};
}

export function evaluateActualExecutions(evidence: DecisionEvidence, records: ExecutionRecord[], now = Date.now()) {
	const associations = new Map<string, number>();
	for (const turn of evidence.turns)
		for (const mutation of turn.mutations)
			if (mutation.executionId)
				associations.set(mutation.executionId, (associations.get(mutation.executionId) ?? 0) + 1);
	const byId = new Map<string, ExecutionRecord[]>();
	for (const record of records) {
		const entries = byId.get(record.id) ?? [];
		entries.push(record);
		byId.set(record.id, entries);
	}
	const rows = evidence.turns
		.flatMap((turn) =>
			turn.mutations.map((mutation) => {
				const record = byId
					.get(mutation.executionId ?? "")
					?.find((entry) => entry.id === mutation.executionId && sameScope(entry.scope, turn.scope));
				const gaps: string[] = [];
				if (!mutation.executionId) gaps.push("mutation-has-no-durable-execution-id");
				else if (!record) gaps.push("execution-evidence-unavailable");
				if (record && (!record.evidence || !["acknowledged", "reconciled"].includes(record.status) || record.issue))
					gaps.push("execution-not-fully-reconciled");
				if (record?.evidence?.source === "operator") gaps.push("operator-evidence-is-not-adapter-observed");
				const orders = record?.evidence?.orders ?? [];
				if (mutation.executionId && associations.get(mutation.executionId) !== 1)
					gaps.push("duplicate-execution-decision-association");
				if (
					!orders.length ||
					orders.some(
						(order) =>
							order.status !== "closed" ||
							order.remaining !== 0 ||
							!Number.isFinite(order.filled) ||
							order.filled <= 0 ||
							order.filled !== order.amount ||
							!Number.isFinite(order.cost) ||
							order.cost <= 0 ||
							order.symbol !== mutation.symbol ||
							order.symbol !== record?.intent.input.symbol,
					)
				)
					gaps.push("complete-terminal-fills-unavailable");
				if (new Set(orders.map((order) => order.id)).size !== orders.length)
					gaps.push("duplicate-native-order-evidence");
				const expectedSource = turn.scope.mode === "paper" ? "paper-ledger" : "exchange";
				const fee = record ? (observedExecutionFee(record) ?? null) : null;
				const feeComplete = fee !== null;
				if (!feeComplete) gaps.push("complete-adapter-observed-quote-fee-unavailable");
				const filledNotional = orders.reduce((sum, order) => sum + order.cost, 0);
				if (!Number.isFinite(filledNotional) || (fee !== null && !Number.isFinite(fee)))
					gaps.push("non-finite-observed-total");
				const claims = turn.claims.filter(
					(claim) =>
						mutation.decisionIds.includes(claim.id) &&
						claim.beforeMutation &&
						claim.claim.symbol === mutation.symbol &&
						["enter", "reduce", "exit"].includes(claim.claim.action),
				);
				if (claims.length !== 1) gaps.push("ambiguous-or-absent-prospective-decision-attribution");
				if (
					record &&
					(!canonicalTime(record.createdAt) ||
						!record.evidence ||
						!canonicalTime(record.evidence.observedAt) ||
						Date.parse(record.evidence.observedAt) > now ||
						record.evidence.observedAt < record.createdAt ||
						(claims.length === 1 && record.createdAt < claims[0].at))
				)
					gaps.push("execution-observation-chronology-invalid");
				return {
					turnId: turn.id,
					mutationId: mutation.id,
					executionId: mutation.executionId ?? null,
					claimId: claims.length === 1 ? claims[0].id : null,
					status: gaps.length ? "insufficient_evidence" : "observed_fills_and_quote_fee",
					observedFilledNotional: !gaps.length ? filledNotional : null,
					observedQuoteFee: !gaps.length ? fee : null,
					feeSource: feeComplete ? expectedSource : null,
					observedAt: record?.evidence?.observedAt ?? null,
					fillEvidence: orders.map((order) => ({
						id: order.id,
						side: order.side,
						filled: order.filled,
						cost: order.cost,
						feeObservation: order.feeObservation ?? null,
					})),
					realizedReturn: null,
					gaps: [...new Set([...gaps, "closed-entry-exit-lot-attribution-unavailable"])].sort(),
				};
			}),
		)
		.sort((a, b) => a.turnId.localeCompare(b.turnId) || a.mutationId.localeCompare(b.mutationId));
	return {
		status: "insufficient_evidence",
		realizedAccountPnl: null,
		actualRealizedReturn: null,
		mutationAttempts: rows.length,
		completeFillAndFeeSamples: rows.filter((row) => row.status === "observed_fills_and_quote_fee").length,
		rows,
		limitations: [
			"No inferred FIFO lots, aggregate account balance attribution or assumed fees.",
			"Execution journal retention gaps remain missing; evaluation never changes or reconciles orders.",
		],
	};
}
