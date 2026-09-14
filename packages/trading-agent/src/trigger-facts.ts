import {
	CHANGE_WINDOW_BASELINE_TOLERANCE_MS,
	type Condition,
	type EvaluatorOptions,
	evaluateCondition,
	type FactSnapshot,
	type FactValue,
	MAX_CHANGE_WINDOW_SEC,
	type RuntimeState,
	type TriggerDefinition,
	transitionTrigger,
} from "@nikopack/ti-triggers";
import { MONITORING_FACT_HISTORY_LIMIT, type MonitoringScopeState } from "./monitoring-state.ts";

export function collectTriggerFactKeys(condition: Condition, keys: Set<string>): void {
	if ("fact" in condition) keys.add(condition.fact.key);
	if ("conditions" in condition) for (const child of condition.conditions) collectTriggerFactKeys(child, keys);
	if ("condition" in condition) collectTriggerFactKeys(condition.condition, keys);
}

export function transitionObservedTrigger(
	definition: TriggerDefinition,
	previous: RuntimeState,
	facts: FactSnapshot,
	advanced: ReadonlySet<string>,
	now: number,
	options: EvaluatorOptions,
) {
	const result = transitionTrigger(definition, previous, facts, now, options);
	const keys = new Set<string>();
	collectTriggerFactKeys(definition.when, keys);
	// Repeated facts cannot produce another event, but an independent clock
	// branch may still prove the condition under the same nested semantics.
	if (
		result.shouldFire &&
		keys.size > 0 &&
		![...keys].some((key) => advanced.has(key)) &&
		evaluateCondition(definition.when, {}, now, previous.stableSince, options, previous.stableSinceByPath).state !==
			"true"
	) {
		result.shouldFire = false;
		result.state = {
			...result.state,
			status: previous.status,
			lastFiredAt: previous.lastFiredAt,
			armed: previous.armed,
		};
	}
	return result;
}

export function parsePositionPnlFactKey(key: string): { symbol: string; positionSide?: "LONG" | "SHORT" } {
	const raw = key.slice("position_pnl_pct:".length);
	const separator = raw.lastIndexOf(":");
	const suffix = separator >= 0 ? raw.slice(separator + 1) : "";
	if (suffix === "LONG" || suffix === "SHORT") {
		const symbol = raw.slice(0, separator);
		if (symbol.trim() === "") throw new Error("position_pnl_pct fact symbol is required");
		return { symbol, positionSide: suffix };
	}
	if (raw.trim() === "") throw new Error("position_pnl_pct fact symbol is required");
	return { symbol: raw };
}

/** Prepare and persist observations inside the caller's trigger-transition transaction. */
export function prepareTriggerFacts(
	entry: MonitoringScopeState,
	observations: FactSnapshot,
	now: number,
	maxAgeMs: number,
): { facts: Record<string, FactValue>; advanced: Set<string>; failed: boolean } {
	if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0)
		throw new Error("Invalid trigger observation time or maximum age");
	const facts: Record<string, FactValue> = {};
	const advanced = new Set<string>();
	let failed = false;
	const retainedKeys = new Set<string>();
	for (const trigger of entry.triggers) collectTriggerFactKeys(trigger.definition.when, retainedKeys);
	const baselines = new Map(entry.facts.filter((fact) => retainedKeys.has(fact.key)).map((fact) => [fact.key, fact]));
	const histories = new Map(
		(entry.factHistory ?? [])
			.filter((history) => retainedKeys.has(history.key))
			.map((history) => [history.key, history]),
	);
	for (const [key, fact] of Object.entries(observations)) {
		if (!retainedKeys.has(key)) continue;
		const previous = baselines.get(key);
		if (
			typeof fact.value !== "number" ||
			!Number.isFinite(fact.value) ||
			(key.startsWith("price:") && fact.value <= 0) ||
			!Number.isFinite(fact.observedAt) ||
			fact.observedAt <= 0 ||
			fact.observedAt > now ||
			now - fact.observedAt > maxAgeMs ||
			(previous &&
				(fact.observedAt < previous.observedAt ||
					(fact.observedAt === previous.observedAt && fact.value !== previous.value)))
		) {
			failed = true;
			continue;
		}
		const isNew = !previous || fact.observedAt > previous.observedAt;
		const baseline = isNew && previous && now - previous.observedAt <= maxAgeMs ? previous : undefined;
		const samples = [
			...(histories.get(key)?.samples ?? []),
			...(previous ? [{ value: previous.value, observedAt: previous.observedAt }] : []),
		].filter(
			(sample) =>
				sample.observedAt < fact.observedAt &&
				fact.observedAt - sample.observedAt <= MAX_CHANGE_WINDOW_SEC * 1000 + CHANGE_WINDOW_BASELINE_TOLERANCE_MS,
		);
		samples.sort((left, right) => left.observedAt - right.observedAt);
		// Keep the first observation per five-second bucket, so frequent/shared
		// pollers cannot evict the one-hour baseline from the bounded history.
		const buckets = new Map<number, { value: number; observedAt: number }>();
		for (const sample of samples) {
			const bucket = Math.floor(sample.observedAt / 5000);
			if (!buckets.has(bucket)) buckets.set(bucket, sample);
		}
		const history = [...buckets.values()].slice(-MONITORING_FACT_HISTORY_LIMIT);
		facts[key] = {
			...fact,
			previousValue: baseline?.value,
			previousObservedAt: baseline?.observedAt,
			history,
		};
		if (!isNew) continue;
		advanced.add(key);
		baselines.set(key, { key, value: fact.value, observedAt: fact.observedAt });
		if (history.length > 0) histories.set(key, { key, samples: history });
		else histories.delete(key);
	}
	entry.facts = [...baselines.values()];
	entry.factHistory = [...histories.values()];
	if (entry.factHistory.length === 0) delete entry.factHistory;
	return { facts, advanced, failed };
}
