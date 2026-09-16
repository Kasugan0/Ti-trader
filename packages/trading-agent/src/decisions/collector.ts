import type { ExecutionScope, MarketDataClient, Ticker } from "@nikopack/ti-trading-engine";
import { failureCode } from "../failure-code.ts";
import { sameScope } from "../plans/model.ts";
import type { DecisionStore } from "./evidence.ts";

export interface DecisionObservationProvider {
	getExecutionScope(): ExecutionScope;
	getEpoch?(): number;
	marketData: Pick<MarketDataClient, "getTicker" | "id" | "mode" | "quoteCurrency">;
}

export class DecisionOutcomeCollector {
	private readonly store: DecisionStore;
	private readonly provider: () => DecisionObservationProvider;
	private readonly now: () => number;
	private running = false;
	private stopped = false;
	constructor(store: DecisionStore, provider: () => DecisionObservationProvider, now: () => number = Date.now) {
		this.store = store;
		this.provider = provider;
		this.now = now;
	}
	start(): void {
		this.stopped = false;
	}
	stop(): void {
		this.stopped = true;
	}
	async collect(): Promise<{ observed: number; missing: number; requests: number; issues: string[] }> {
		const report = { observed: 0, missing: 0, requests: 0, issues: [] as string[] };
		if (this.running || this.stopped) return report;
		this.running = true;
		try {
			const runtime = this.provider();
			const scope = runtime.getExecutionScope();
			const epoch = runtime.getEpoch?.() ?? 0;
			let state = this.store.evidence(scope);
			if (
				state.studies?.some(
					(study) =>
						study.epoch !== epoch &&
						(!study.stoppedAt ||
							state.turns.some(
								(turn) =>
									turn.studyId === study.id &&
									turn.claims.some(
										(claim) =>
											claim.evaluation && !state.outcomes?.some((outcome) => outcome.claimId === claim.id),
									),
							)),
				)
			) {
				this.store.invalidateEpoch(scope, epoch);
				state = this.store.evidence(scope);
				report.issues.push("paper-reset-invalidated-study");
			}
			const outcomes = new Set(state.outcomes?.map((outcome) => outcome.claimId));
			const queuedAt = this.now();
			const queue = state.turns
				.flatMap((turn) =>
					turn.claims
						.filter((claim) => claim.evaluation && !outcomes.has(claim.id))
						.map((claim) => ({
							turn,
							claim,
							priority:
								Date.parse(claim.evaluation!.deadlineAt) < queuedAt
									? 1
									: Date.parse(claim.evaluation!.dueAt) <= queuedAt
										? 0
										: 2,
						})),
				)
				.sort(
					(a, b) =>
						a.priority - b.priority ||
						a.claim.evaluation!.deadlineAt.localeCompare(b.claim.evaluation!.deadlineAt) ||
						a.claim.id.localeCompare(b.claim.id),
				);
			const studies = new Map(state.studies?.map((study) => [study.id, study]));
			const attempts = new Map(state.attempts?.map((attempt) => [attempt.claimId, attempt]));
			const groups = new Map<string, typeof queue>();
			const expired: Parameters<DecisionStore["completeOutcomes"]>[0] = [];
			for (const sample of queue.slice(0, 100)) {
				const { turn, claim } = sample;
				const enrollment = claim.evaluation!;
				if (queuedAt > Date.parse(enrollment.deadlineAt)) {
					expired.push({ turnId: turn.id, claimId: claim.id, reason: "missed-endpoint-window" });
					continue;
				}
				if (queuedAt < Date.parse(enrollment.dueAt)) continue;
				const lastAttempt = attempts.get(claim.id);
				if (lastAttempt && queuedAt - Date.parse(lastAttempt.at) < 5000) continue;
				const symbol = claim.claim.symbol;
				if (!symbol || enrollment.gap) throw new Error("Invalid pending prospective enrollment");
				const group = groups.get(symbol) ?? [];
				group.push(sample);
				groups.set(symbol, group);
			}
			const isCurrent = () => {
				const current = this.provider();
				return (
					!this.stopped &&
					sameScope(scope, current.getExecutionScope()) &&
					sameScope(scope, runtime.getExecutionScope()) &&
					(current.getEpoch?.() ?? 0) === epoch
				);
			};
			for (const [symbol, group] of groups) {
				if (this.stopped || report.requests >= 20) break;
				if (!isCurrent()) {
					report.issues.push("scope-changed-during-observation");
					break;
				}
				const pending = group.filter(({ turn, claim }) => {
					if (this.now() <= Date.parse(claim.evaluation!.deadlineAt)) return true;
					expired.push({ turnId: turn.id, claimId: claim.id, reason: "missed-endpoint-window" });
					return false;
				});
				if (!pending.length) continue;
				this.store.recordAttempts(pending.map(({ claim }) => ({ claimId: claim.id, reason: "request-started" })));
				report.requests++;
				let ticker: Ticker | undefined;
				let providerIssue: string | undefined;
				try {
					let timeout: ReturnType<typeof setTimeout> | undefined;
					try {
						ticker = await Promise.race([
							runtime.marketData.getTicker(symbol),
							new Promise<never>((_resolve, reject) => {
								timeout = setTimeout(() => reject(new Error("Decision ticker observation timed out")), 10_000);
							}),
						]);
					} finally {
						if (timeout) clearTimeout(timeout);
					}
				} catch (error) {
					providerIssue = `provider-${failureCode(error)}`;
				}
				const capturedAt = this.now();
				if (this.stopped) break;
				if (!isCurrent()) {
					report.issues.push("scope-changed-during-observation");
					break;
				}
				const completions: Parameters<DecisionStore["completeOutcomes"]>[0] = [];
				const failures: Array<{ claimId: string; reason: string }> = [];
				for (const { turn, claim } of pending) {
					const enrollment = claim.evaluation!;
					const study = studies.get(enrollment.studyId);
					if (!study) throw new Error("Frozen protocol unavailable");
					let reason = providerIssue;
					if (
						runtime.marketData.id !== scope.exchange ||
						runtime.marketData.mode !== scope.mode ||
						runtime.marketData.quoteCurrency !== scope.quoteCurrency
					)
						reason = "provider-scope-mismatch";
					else if (capturedAt > Date.parse(enrollment.deadlineAt)) reason = "missed-endpoint-window";
					else if (ticker) {
						if (ticker.symbol !== symbol) reason = "source-symbol-mismatch";
						else if (ticker.sourceTimestampKnown !== true) reason = "source-time-provenance-unavailable";
						else if (ticker.last === undefined || !Number.isFinite(ticker.last) || ticker.last <= 0)
							reason = "invalid-source-price";
						else if (
							!Number.isSafeInteger(ticker.timestamp) ||
							ticker.timestamp < 0 ||
							ticker.timestamp > capturedAt
						)
							reason = "invalid-or-future-source-time";
						else if (capturedAt - ticker.timestamp > study.config.maxSourceAgeSeconds * 1000)
							reason = "stale-source-time";
						else if (ticker.timestamp < Date.parse(enrollment.dueAt)) reason = "source-before-fixed-horizon";
					}
					if (reason || !ticker || ticker.last === undefined) {
						const issue = reason ?? "missing-ticker";
						failures.push({ claimId: claim.id, reason: issue });
						report.issues.push(`${claim.id}:${issue}`);
						if (issue === "missed-endpoint-window")
							completions.push({ turnId: turn.id, claimId: claim.id, reason: issue });
					} else
						completions.push({
							turnId: turn.id,
							claimId: claim.id,
							endpoint: {
								at: new Date(capturedAt).toISOString(),
								sourceAt: new Date(ticker.timestamp).toISOString(),
								price: ticker.last,
								symbol,
								scope,
								source: "marketData.getTicker",
								sourceTimestampKnown: true,
							},
						});
				}
				// Persist one received quote for all matching samples before fetching another symbol.
				for (const outcome of this.store.completeOutcomes(completions)) {
					if (outcome.status === "observed") report.observed++;
					else report.missing++;
				}
				this.store.recordAttempts(failures, false);
			}
			if (expired.length && isCurrent()) report.missing += this.store.completeOutcomes(expired).length;
			return report;
		} finally {
			this.running = false;
		}
	}
}
