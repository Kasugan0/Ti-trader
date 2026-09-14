import { type Condition, evaluateCondition, MAX_CHANGE_WINDOW_SEC } from "@nikopack/ti-triggers";
import { describe, expect, it } from "vitest";
import {
	createMemoryMonitoringStore,
	ensureMonitoringScope,
	MONITORING_FACT_HISTORY_LIMIT,
	MONITORING_MAX_AGE_MS,
} from "../monitoring-state.ts";
import { collectTriggerFactKeys, parsePositionPnlFactKey, prepareTriggerFacts } from "../trigger-facts.ts";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const KEY = "price:BTC/USDT";
const condition: Condition = {
	kind: "change",
	fact: { key: KEY },
	windowSec: MAX_CHANGE_WINDOW_SEC,
	operator: "gte",
	value: 10,
	unit: "percent",
};

function fixture() {
	const entry = ensureMonitoringScope(
		{ version: 1, scopes: [] },
		{ mode: "paper", exchange: "binance", marketType: "spot", quoteCurrency: "USDT", accountId: "fixture" },
		NOW,
	);
	entry.triggers.push({
		definition: {
			id: "change",
			name: "change",
			when: condition,
			// biome-ignore lint/suspicious/noThenProperty: public trigger action field.
			then: { kind: "notify", message: "review" },
		},
		revision: "change",
		state: { status: "active", armed: true },
		updatedAt: NOW,
	});
	return entry;
}

describe("shared trigger facts", () => {
	it("retains a full one-hour baseline despite faster-than-monitor polling", () => {
		const entry = fixture();
		for (let offset = 0; offset < MAX_CHANGE_WINDOW_SEC * 1000; offset += 1000)
			prepareTriggerFacts(entry, { [KEY]: { value: 100, observedAt: NOW + offset } }, NOW + offset, 10_000);
		const now = NOW + MAX_CHANGE_WINDOW_SEC * 1000;
		const result = prepareTriggerFacts(entry, { [KEY]: { value: 110, observedAt: now } }, now, 10_000);
		expect(evaluateCondition(condition, result.facts, now).state).toBe("true");
		expect(entry.factHistory?.[0].samples.length).toBeLessThanOrEqual(MONITORING_FACT_HISTORY_LIMIT);
		expect(() => createMemoryMonitoringStore({ version: 1, scopes: [entry] })).not.toThrow();
	});

	it.each([
		{ value: 0, observedAt: NOW + 1 },
		{ value: 100, observedAt: NOW - 1 },
		{ value: 100, observedAt: NOW + 2 },
		{ value: 110, observedAt: NOW },
		{ value: Number.NaN, observedAt: NOW + 1 },
	])("does not replace a baseline with an invalid, late or contradictory observation (%#)", (fact) => {
		const entry = fixture();
		prepareTriggerFacts(entry, { [KEY]: { value: 100, observedAt: NOW } }, NOW, MONITORING_MAX_AGE_MS);
		const result = prepareTriggerFacts(entry, { [KEY]: fact }, NOW + 1, MONITORING_MAX_AGE_MS);
		expect(result.failed).toBe(true);
		expect(result.facts).toEqual({});
		expect(entry.facts).toEqual([{ key: KEY, value: 100, observedAt: NOW }]);
	});

	it("preserves unrelated retained facts but prunes removed trigger history", () => {
		const entry = fixture();
		prepareTriggerFacts(entry, { [KEY]: { value: 100, observedAt: NOW } }, NOW, MONITORING_MAX_AGE_MS);
		prepareTriggerFacts(entry, { [KEY]: { value: 110, observedAt: NOW + 5000 } }, NOW + 5000, MONITORING_MAX_AGE_MS);
		const before = structuredClone(entry);
		prepareTriggerFacts(entry, {}, NOW + 6000, MONITORING_MAX_AGE_MS);
		expect(entry).toEqual(before);
		entry.triggers = [];
		prepareTriggerFacts(entry, {}, NOW + 7000, MONITORING_MAX_AGE_MS);
		expect(entry.facts).toEqual([]);
		expect(entry.factHistory).toBeUndefined();
	});

	it("collects nested keys and separates futures settlement from hedge side", () => {
		const keys = new Set<string>();
		collectTriggerFactKeys(
			{
				kind: "not",
				condition: { kind: "stable_for", durationSec: 10, condition: { kind: "all", conditions: [condition] } },
			},
			keys,
		);
		expect([...keys]).toEqual([KEY]);
		expect(parsePositionPnlFactKey("position_pnl_pct:BTC/USDT:USDT:SHORT")).toEqual({
			symbol: "BTC/USDT:USDT",
			positionSide: "SHORT",
		});
		expect(parsePositionPnlFactKey("position_pnl_pct:BTC/USDT:USDT")).toEqual({ symbol: "BTC/USDT:USDT" });
	});
});
