import type { ExecutionScope } from "@nikopack/ti-trading-engine";
import {
	deliverMonitoringNotifications,
	ensureMonitoringScope,
	type MonitoringNotification,
	readMonitoringHealth,
} from "../monitoring-state.ts";
import type { OperationalObservation } from "../operational-health.ts";
import { sameScope } from "./model.ts";
import type { PlanStore } from "./store.ts";

export function deliverPlanNotifications(
	store: PlanStore,
	scope: ExecutionScope,
	deliver: (event: MonitoringNotification) => boolean,
	isCurrent: () => boolean,
	now: () => number = Date.now,
) {
	if (!isCurrent()) return { attempted: 0, delivered: 0, failures: [] };
	store.storage.transact((state) => {
		if (!state.monitoring) return;
		const entry = ensureMonitoringScope(state.monitoring, scope, now());
		for (const event of entry.notifications) {
			const reference = event.planReference;
			if (!reference || event.finishedAt !== undefined) continue;
			const plan = state.plans.find((plan) => plan.id === reference.id && sameScope(plan.scope, scope));
			if (plan?.status === "tracking" && plan.activeVersion === reference.version) continue;
			event.status = "cancelled";
			event.finishedAt = now();
			delete event.leaseId;
			delete event.leaseUntil;
		}
	});
	return deliverMonitoringNotifications(
		store.monitoring,
		scope,
		"plans",
		(event) => {
			const reference = event.planReference!;
			const plan = store.read(reference.id, scope);
			if (!isCurrent() || plan.status !== "tracking" || plan.activeVersion !== reference.version) return false;
			return deliver(event);
		},
		isCurrent,
		now,
	);
}

export function readPlanHealth(store: PlanStore, scope: ExecutionScope, enabled: boolean): OperationalObservation {
	try {
		const plans = store.list(scope);
		const observation = readMonitoringHealth(store.monitoring, scope).find((entry) => entry.source === "plans");
		const pendingNotifications = observation?.pendingNotifications ?? 0;
		return {
			source: "plans",
			enabled: (enabled && plans.some((plan) => plan.status === "tracking")) || pendingNotifications > 0,
			lastSuccessAt: observation?.lastObservationAt,
			lastFailureAt: observation?.lastFailureAt,
			errorCode: observation?.errorCode,
			pendingNotifications,
		};
	} catch {
		// A research-store failure is visible but cannot become a new global trading block.
		return {
			source: "plans",
			enabled: true,
			lastFailureAt: Date.now(),
			errorCode: "plan-state-unavailable",
			pendingNotifications: 0,
		};
	}
}
