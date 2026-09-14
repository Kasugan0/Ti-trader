import { createHash } from "node:crypto";
import { AccountRiskError, accountRiskFacts, verifiedReducingOrder } from "./account-risk.ts";
import type { TradingEngine } from "./engine.ts";
import { isUnresolvedExecution } from "./execution-journal.ts";
import { reduceSide } from "./protection.ts";
import type { AccountSnapshot, Position } from "./types.ts";

export interface RiskSupervisionReport {
	at: number;
	reasons: string[];
	actions: Array<{ action: string; reference: string; status: "completed" | "unknown" | "failed"; reason?: string }>;
	snapshot?: AccountSnapshot;
}

/**
 * Runs without a model. Network failures leave durable entry blocks; they are
 * not interpreted as a rejected submission or as permission to retry an exit.
 */
export async function superviseAccountRisk(
	engine: TradingEngine,
	options: { timeoutMs: number; protectionAttempts: number; now?: () => number },
): Promise<RiskSupervisionReport> {
	const now = options.now ?? Date.now;
	const guard = engine.accountRisk;
	if (!guard?.state()) throw new Error("Independent risk supervision requires configured account hard limits");
	const report: RiskSupervisionReport = { at: now(), reasons: [], actions: [] };
	try {
		await guard.reconcileMutation(options.timeoutMs);
	} catch {
		report.actions.push({
			action: "reconcile-mutation",
			reference: guard.state()?.mutation?.id ?? "account",
			status: "unknown",
			reason: "mutation-reconciliation-unavailable",
		});
	}
	if (engine.getExecutionStatus().unresolved.some((record) => record.status === "unknown")) {
		const recovery = await engine.recoverExecutions({
			unknownOnly: true,
			maxRecords: 1,
			attemptsPerRecord: 1,
			lookupTimeoutMs: Math.min(options.timeoutMs, 10000),
			backoffMs: 1000,
		});
		for (const issue of recovery.issues)
			report.actions.push({
				action: "reconcile",
				reference: issue.executionId,
				status: "unknown",
				reason: issue.issue,
			});
	}
	const observed = await guard.inspect();
	report.snapshot = observed.snapshot;
	report.reasons = observed.assessment.reasons;
	const scope = engine.getExecutionScope();
	const limits = guard.state()!.limits;
	let snapshot = observed.snapshot;
	const executions = engine.listExecutions();
	for (const target of engine.protectionTargets()) {
		const entry = executions.find((execution) => execution.id === target.executionId);
		// Unknown openings retain their reservation. Repair only observed holdings,
		// never assume an unacknowledged order failed or that its intended size filled.
		if (entry?.settlement?.outcome === "release") {
			engine.retireProtectionTarget(target.id);
			continue;
		}
		const position = snapshot.positions.find(
			(position) =>
				position.symbol === target.symbol &&
				reduceSide(position) === target.side &&
				(scope.positionMode !== "hedge" || target.positionSide === position.positionSide),
		);
		if (!position) {
			if (
				(!entry || !isUnresolvedExecution(entry)) &&
				!snapshot.orders.some((order) => order.symbol === target.symbol && order.side !== target.side)
			)
				engine.retireProtectionTarget(target.id);
			continue;
		}
		const facts = accountRiskFacts(snapshot, scope);
		const exposure = facts.exposures.find(
			(exposure) =>
				!exposure.pending &&
				exposure.symbol === position.symbol &&
				Math.sign(exposure.notional) === (target.side === "sell" ? 1 : -1),
		);
		if (exposure && exposure.protectionCoveragePct >= limits.minProtectionCoveragePct) {
			if (target.lastRepairIntentId) engine.finishProtectionRepair(target.id, true);
			continue;
		}
		let repairId = engine.claimProtectionRepair(target.id);
		let failures = target.failures ?? 0;
		const previousId = engine.findExecutionIntent(repairId);
		if (previousId) {
			const previous = engine.listExecutions().find((record) => record.id === previousId);
			if (!previous || isUnresolvedExecution(previous)) {
				report.actions.push({ action: "protect", reference: previousId, status: "unknown" });
				continue;
			}
			engine.finishProtectionRepair(target.id, previous.settlement?.outcome === "commit");
			failures = previous.settlement?.outcome === "commit" ? 0 : failures + 1;
			repairId = engine.claimProtectionRepair(target.id);
		}
		if (failures >= options.protectionAttempts) {
			report.actions.push({
				action: "protect",
				reference: target.id,
				status: "failed",
				reason: "protection-attempts-exhausted",
			});
			continue;
		}
		const uncovered = Math.abs(position.amount) * (1 - (exposure?.protectionCoveragePct ?? 0) / 100);
		try {
			const plan = await engine.prepareOrder(target.side, {
				symbol: target.symbol,
				type: "stop_market",
				amount: uncovered,
				stopPrice: target.stopPrice,
				...(target.symbol.includes(":")
					? { reduceOnly: true, positionSide: scope.positionMode === "hedge" ? target.positionSide : undefined }
					: {}),
			});
			const result = await engine.placeOrder(plan, {
				intentId: repairId,
				allowUnconfirmedLive: true,
				timeoutMs: options.timeoutMs,
			});
			engine.finishProtectionRepair(target.id, true);
			report.actions.push({ action: "protect", reference: result.executionId!, status: "completed" });
			snapshot = await guard.snapshot();
		} catch (error) {
			report.actions.push({
				action: "protect",
				reference: repairId,
				status: engine.findExecutionIntent(repairId) ? "unknown" : "failed",
				reason: error instanceof AccountRiskError ? error.message : "protection-submission-failed",
			});
			if (!engine.findExecutionIntent(repairId)) engine.finishProtectionRepair(target.id);
			guard.block("protection-repair-failed");
		}
	}
	const afterRepair = await guard.inspect();
	snapshot = afterRepair.snapshot;
	report.snapshot = snapshot;
	report.reasons = afterRepair.assessment.reasons;
	if (report.reasons.every((reason) => reason === "account-mutation-pending")) return report;
	if (limits.cancelEntriesOnBreach) {
		for (const order of snapshot.orders) {
			if (snapshot.positions.some((position) => verifiedReducingOrder(order, position, scope))) continue;
			if (!order.symbol.includes(":") && order.side === "sell") continue;
			try {
				await engine.cancelOrder(order.id, order.symbol);
				report.actions.push({ action: "cancel-entry", reference: order.id, status: "completed" });
			} catch (error) {
				report.actions.push({
					action: "cancel-entry",
					reference: order.id,
					status: "unknown",
					reason: error instanceof AccountRiskError ? error.message : "cancellation-outcome-unknown",
				});
			}
		}
	}
	if (limits.reduceOnBreach && !report.reasons.some((reason) => reason.startsWith("stale:"))) {
		for (const position of snapshot.positions) {
			// An unknown protection/exit can still fill. Do not race a second exit.
			if (engine.getExecutionStatus().unresolved.some((record) => record.intent.input.symbol === position.symbol))
				continue;
			try {
				await controlledRiskClose(engine, position, options.timeoutMs);
				report.actions.push({ action: "reduce", reference: position.symbol, status: "completed" });
			} catch (error) {
				report.actions.push({
					action: "reduce",
					reference: position.symbol,
					status: "failed",
					reason: error instanceof AccountRiskError ? error.message : "controlled-reduction-failed",
				});
			}
		}
	}
	return report;
}

export async function controlledRiskClose(
	engine: TradingEngine,
	position: Position,
	timeoutMs: number,
	signal?: AbortSignal,
	intentId?: string,
): Promise<void> {
	const snapshot = await engine.accountRisk!.snapshot();
	const current = snapshot.positions.find(
		(candidate) =>
			candidate.symbol === position.symbol &&
			reduceSide(candidate) === reduceSide(position) &&
			candidate.positionSide === position.positionSide,
	);
	if (!current) return;
	// Never cancel the only stop before a non-atomic close. Adapters lacking an
	// atomic protected-close primitive must leave protection in place and fail.
	const protectedOrders = snapshot.orders.filter((order) =>
		verifiedReducingOrder(order, current, engine.getExecutionScope()),
	);
	const identity = createHash("sha256")
		.update(
			JSON.stringify([
				"risk-close",
				engine.getExecutionScope(),
				snapshot.epoch,
				position.symbol,
				position.positionSide,
				current.amount,
				engine.accountRisk!.state()?.revision,
			]),
		)
		.digest("hex");
	const plan = await engine.prepareOrder(reduceSide(current), {
		symbol: current.symbol,
		type: "market",
		amount: Math.abs(current.amount),
		...(current.symbol.includes(":")
			? {
					reduceOnly: true,
					positionSide: engine.getExecutionScope().positionMode === "hedge" ? current.positionSide : undefined,
				}
			: {}),
	});
	await engine.placeOrder(
		plan,
		{
			intentId: intentId ?? identity,
			timeoutMs,
			allowUnconfirmedLive: true,
			...(protectedOrders.length ? { replacementIds: protectedOrders.map((order) => order.id) } : {}),
		},
		signal,
	);
}
