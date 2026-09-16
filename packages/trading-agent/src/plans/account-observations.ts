import {
	boundedLookup,
	type ExecutionRecord,
	type ExecutionScope,
	isProtectiveExit,
	isUnresolvedExecution,
	type MarketDataClient,
	type Order,
	type Position,
	protectionCoverage,
} from "@nikopack/ti-trading-engine";
import { failureCode } from "../failure-code.ts";
import { type PlanAccountObservation, sameScope, type TradePlan } from "./model.ts";
import type { PlanStore } from "./store.ts";

export interface PlanEvidenceReader {
	listExecutions(): ExecutionRecord[];
	refreshExecutionEvidence(id: string): Promise<void>;
	acknowledgeExecutionArchive(id: string, revision: number): void;
}

/** Account positions are context, never proof that a plan owns the same-symbol inventory. */
export function planAccountObservation(
	plan: TradePlan,
	records: ExecutionRecord[],
	positions: Position[] | undefined,
	orders: Order[] | undefined,
	now: number,
	coveragePct = 95,
	errors: string[] = [],
): PlanAccountObservation {
	if (!Number.isFinite(coveragePct) || coveragePct <= 0 || coveragePct > 100)
		throw new Error("Invalid protection coverage threshold");
	const version = plan.activeVersion ?? plan.versions.length;
	const symbol = plan.versions[version - 1].content.symbol;
	const limitations = [...errors];
	const matchingPositions = positions?.filter((position) => position.symbol === symbol && position.amount !== 0);
	const malformed = matchingPositions?.some(
		(position) =>
			!Number.isFinite(position.amount) ||
			(plan.scope.positionMode === "hedge" && position.positionSide !== "LONG" && position.positionSide !== "SHORT"),
	);
	const matchingOrders = orders?.filter((order) => order.symbol === symbol);
	const malformedOrders = matchingOrders?.some(
		(order) =>
			![order.amount, order.filled, order.remaining].every((value) => Number.isFinite(value) && value >= 0) ||
			order.status === "unknown" ||
			((order.type === "stop" || order.type === "stop_market") &&
				!(typeof order.stopPrice === "number" && Number.isFinite(order.stopPrice) && order.stopPrice > 0)) ||
			Math.abs(order.amount - order.filled - order.remaining) > Math.max(1, order.amount) * 1e-8,
	);
	if (positions === undefined || malformed || (matchingPositions?.length ?? 0) > 4)
		limitations.push("Position quantity or side unavailable");
	if (orders === undefined || malformedOrders) limitations.push("Open-order evidence unavailable");
	const positionEvidence =
		positions !== undefined && !malformed && (matchingPositions?.length ?? 0) <= 4
			? (matchingPositions ?? []).map((position) => {
					const coverages = matchingOrders
						?.filter((order) => order.status === "open" && isProtectiveExit(order, position, plan.scope))
						.map((order) => protectionCoverage(order, position, coveragePct, plan.scope.positionMode));
					const protection =
						orders === undefined || malformedOrders
							? "unknown"
							: coverages?.includes("protected")
								? "protected"
								: coverages?.includes("partial")
									? "partial"
									: "none";
					return {
						side: position.positionSide ?? (position.amount < 0 ? "SHORT" : "LONG"),
						amount: position.amount,
						protection,
					};
				})
			: [];
	const unresolved = records.filter(isUnresolvedExecution);
	if (unresolved.length)
		limitations.push(`${unresolved.length} unresolved execution(s); use /recovery without resubmitting`);
	const protection: PlanAccountObservation["protection"] =
		positions === undefined || malformed || (matchingPositions?.length ?? 0) > 4
			? "unknown"
			: !positionEvidence.length
				? "no-position"
				: positionEvidence.some((position) => position.protection === "unknown")
					? "unknown"
					: positionEvidence.some((position) => position.protection === "none")
						? "none"
						: positionEvidence.some((position) => position.protection === "partial")
							? "partial"
							: "protected";
	return {
		version,
		at: new Date(now).toISOString(),
		status: limitations.length ? "unknown" : "observed",
		orders: records
			.flatMap((record) =>
				(record.evidence?.orders ?? []).map((order) => ({
					executionId: record.id,
					id: order.id,
					status: order.status,
					filled: order.filled,
					remaining: order.remaining,
				})),
			)
			.sort((left, right) => `${left.executionId}:${left.id}`.localeCompare(`${right.executionId}:${right.id}`)),
		protection,
		positions: positionEvidence,
		limitations: [...new Set(limitations)].slice(0, 20),
	};
}

export async function observePlanAccounts(
	store: PlanStore,
	plans: TradePlan[],
	scope: ExecutionScope,
	client: Partial<Pick<MarketDataClient, "getPositions" | "getOpenOrders">>,
	reader: PlanEvidenceReader | undefined,
	isCurrent: () => boolean,
	now: () => number,
	coveragePct = 95,
	includeHistory = false,
): Promise<Map<string, { observation: PlanAccountObservation; eventId?: string; positions?: Position[] }>> {
	const result = new Map<string, { observation: PlanAccountObservation; eventId?: string; positions?: Position[] }>();
	if (!plans.length) return result;
	const errors = new Map<string, string[]>();
	let records = reader?.listExecutions() ?? plans.flatMap((plan) => plan.executions.map((entry) => entry.record));
	const relevant = (record: ExecutionRecord) =>
		record.reference?.kind === "trade-plan" &&
		sameScope(record.scope, scope) &&
		plans.some(
			(plan) =>
				plan.id === record.reference?.id && (includeHistory || plan.activeVersion === record.reference?.version),
		);
	const needsRefresh = (record: ExecutionRecord) =>
		record.evidence?.orders.some(
			(order) => order.status === "open" || (order.filled > 0 && order.feeObservation?.completeness !== "complete"),
		);
	if (!reader)
		for (const record of records.filter(relevant))
			if (needsRefresh(record)) errors.set(record.reference!.id, ["Pending execution evidence was not refreshed"]);
	if (reader) {
		// Bound journal lookups independently of the number of historical executions.
		const refreshable = records
			.filter(relevant)
			.filter((record) => !isUnresolvedExecution(record) && needsRefresh(record))
			.sort((left, right) => left.id.localeCompare(right.id));
		const offset = refreshable.length ? store.claimQueryOffset(scope, refreshable.length, 20) : 0;
		const selected = [...refreshable.slice(offset), ...refreshable.slice(0, offset)].slice(0, 20);
		for (const record of refreshable.filter((record) => !selected.some((selected) => selected.id === record.id)))
			errors.set(record.reference!.id, ["Some linked order evidence awaits the next bounded refresh"]);
		for (const record of selected) {
			if (!isCurrent()) return result;
			try {
				await reader.refreshExecutionEvidence(record.id);
			} catch (error) {
				errors.set(record.reference!.id, [
					...(errors.get(record.reference!.id) ?? []),
					`Execution ${record.id}: ${failureCode(error)}`,
				]);
			}
		}
		records = reader.listExecutions();
		for (const record of records.filter(relevant)) {
			if (!isCurrent()) return result;
			if (record.archiveAcknowledgedRevision === record.revision) continue;
			try {
				store.archiveExecution(record);
				reader.acknowledgeExecutionArchive(record.id, record.revision);
			} catch (error) {
				errors.set(record.reference!.id, [
					...(errors.get(record.reference!.id) ?? []),
					`Archive ${record.id}: ${failureCode(error)}`,
				]);
			}
		}
	}
	let positions: Position[] | undefined;
	let openOrders: Order[] | undefined;
	const accountErrors: string[] = [];
	if (!isCurrent()) return result;
	try {
		if (client.getPositions) positions = await boundedLookup(() => client.getPositions!(), 1500);
	} catch (error) {
		accountErrors.push(`Positions: ${failureCode(error)}`);
	}
	if (!isCurrent()) return result;
	try {
		if (client.getOpenOrders) openOrders = await boundedLookup(() => client.getOpenOrders!(), 1500);
	} catch (error) {
		accountErrors.push(`Orders: ${failureCode(error)}`);
	}
	if (!isCurrent()) return result;
	for (const plan of plans) {
		const latest = new Map<string, ExecutionRecord>();
		for (const record of [...plan.executions.map((entry) => entry.record), ...records].filter(relevant)) {
			if (record.reference?.id !== plan.id) continue;
			if ((latest.get(record.id)?.revision ?? -1) <= record.revision) latest.set(record.id, record);
		}
		const observation = planAccountObservation(
			plan,
			[...latest.values()].filter((record) => record.reference?.version === plan.activeVersion),
			positions,
			openOrders,
			now(),
			coveragePct,
			[...accountErrors, ...(errors.get(plan.id) ?? [])],
		);
		const eventId = store.observeAccount(plan.id, scope, observation);
		result.set(plan.id, {
			observation,
			eventId,
			positions: positions?.filter((position) => position.symbol === plan.versions[0].content.symbol),
		});
	}
	return result;
}
