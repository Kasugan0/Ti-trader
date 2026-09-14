import { describe, expect, it } from "vitest";
import { evaluateCondition, transitionTrigger } from "./evaluator.ts";
import { type FactSnapshot, MAX_CHANGE_WINDOW_SEC, type RuntimeState, type TriggerDefinition } from "./model.ts";
import { validateCondition, validateTriggerDefinition } from "./schema.ts";

const facts: FactSnapshot = { price: { value: 101, observedAt: 1000, previousValue: 99, previousObservedAt: 900 } };
const base: RuntimeState = { status: "active", armed: true };
const definition = (mode: "once" | "on_edge" | "while_true" = "on_edge"): TriggerDefinition => ({
	id: "t",
	name: "test",
	when: { kind: "compare", fact: { key: "price" }, operator: "gt", value: 100 },
	// biome-ignore lint/suspicious/noThenProperty: `then` is the public trigger action field.
	then: { kind: "notify", message: "hit" },
	policy: { mode },
});
describe("trigger evaluator", () => {
	it("handles unknown and stale/nonfinite facts", () => {
		expect(
			evaluateCondition({ kind: "compare", fact: { key: "missing" }, operator: "gt", value: 1 }, {}, 100).state,
		).toBe("unknown");
		expect(
			evaluateCondition(
				{ kind: "compare", fact: { key: "price" }, operator: "gt", value: 1 },
				{ price: { value: Number.NaN, observedAt: 1 } },
				100,
			).state,
		).toBe("unknown");
	});
	it("re-fires on each edge", () => {
		const first = transitionTrigger(definition(), base, facts, 1000);
		const held = transitionTrigger(definition(), first.state, facts, 1100);
		const reset = transitionTrigger(definition(), held.state, { price: { value: 99, observedAt: 1200 } }, 1200);
		const second = transitionTrigger(definition(), reset.state, facts, 1300);
		expect(first.shouldFire).toBe(true);
		expect(held.shouldFire).toBe(false);
		expect(second.shouldFire).toBe(true);
	});
	it("fires once immediately and while_true respects cooldown", () => {
		expect(transitionTrigger(definition("once"), base, facts, 1000).shouldFire).toBe(true);
		const d = definition("while_true");
		const one = transitionTrigger(d, base, facts, 1000);
		expect(one.shouldFire).toBe(true);
		expect(transitionTrigger(d, one.state, facts, 1500).shouldFire).toBe(true);
		const cooled: TriggerDefinition = { ...definition("while_true"), policy: { mode: "while_true", cooldownSec: 1 } };
		const cooledOne = transitionTrigger(cooled, base, facts, 1000);
		expect(cooledOne.shouldFire).toBe(true);
		expect(transitionTrigger(cooled, cooledOne.state, facts, 1500).shouldFire).toBe(false);
		expect(transitionTrigger(cooled, cooledOne.state, facts, 2000).shouldFire).toBe(true);
	});
	it("preserves independent nested stable_for state and rejects stale/future windows", () => {
		const condition = {
			kind: "all" as const,
			conditions: [
				{
					kind: "stable_for" as const,
					condition: { kind: "compare" as const, fact: { key: "price" }, operator: "gt" as const, value: 100 },
					durationSec: 10,
				},
				{
					kind: "stable_for" as const,
					condition: { kind: "compare" as const, fact: { key: "price2" }, operator: "gt" as const, value: 100 },
					durationSec: 20,
				},
			],
		};
		const input = { price: { value: 101, observedAt: 1000 }, price2: { value: 101, observedAt: 1000 } };
		const first = evaluateCondition(condition, input, 1000);
		const second = evaluateCondition(condition, input, 11000, undefined, { maxAgeMs: 60_000 });
		expect(first.stableSinceByPath).toEqual({ "$.0": 1000, "$.1": 1000 });
		expect(second.state).toBe("false");
		expect(
			evaluateCondition(
				{ kind: "compare", fact: { key: "price" }, operator: "gt", value: 1 },
				{ price: { value: 2, observedAt: 99_999 } },
				1000,
			).state,
		).toBe("unknown");
		expect(
			evaluateCondition(
				{ kind: "change", fact: { key: "price" }, windowSec: 100, operator: "gt", value: 0, unit: "absolute" },
				{ price: { value: 2, observedAt: 2_000, history: [{ value: 1, observedAt: 3_000 }] } },
				2_000,
			).state,
		).toBe("unknown");
	});

	it("requires an explicit historical baseline for change windows", () => {
		const condition = {
			kind: "change" as const,
			fact: { key: "price" },
			windowSec: 60,
			operator: "gte" as const,
			value: 10,
			unit: "percent" as const,
		};
		expect(
			evaluateCondition(
				condition,
				{ price: { value: 110, observedAt: 61_000, previousValue: 100, previousObservedAt: 56_000 } },
				61_000,
			).state,
		).toBe("unknown");
		expect(
			evaluateCondition(
				condition,
				{
					price: {
						value: 110,
						observedAt: 61_000,
						previousValue: 108,
						previousObservedAt: 56_000,
						history: [{ value: 100, observedAt: 1_000 }],
					},
				},
				61_000,
			).state,
		).toBe("true");
		expect(
			evaluateCondition(
				condition,
				{ price: { value: 110, observedAt: 61_000, history: [{ value: 100, observedAt: 30_000 }] } },
				61_000,
			).state,
		).toBe("unknown");
	});

	it("rejects unordered or stale cross baselines and preserves edge arming through unknown", () => {
		const cross: TriggerDefinition = {
			id: "cross",
			name: "cross",
			when: { kind: "cross", fact: { key: "price" }, direction: "above", value: 100 },
			// biome-ignore lint/suspicious/noThenProperty: public trigger action field
			then: { kind: "notify", message: "hit" },
			policy: { mode: "on_edge" },
		};
		expect(
			evaluateCondition(
				cross.when,
				{ price: { value: 101, observedAt: 1_000, previousValue: 99, previousObservedAt: 1_000 } },
				1_000,
			).state,
		).toBe("unknown");
		expect(
			evaluateCondition(
				cross.when,
				{ price: { value: 101, observedAt: 10 * 60_000, previousValue: 99, previousObservedAt: 1_000 } },
				10 * 60_000,
			).state,
		).toBe("unknown");
		const first = transitionTrigger(cross, base, facts, 1_000);
		const unknown = transitionTrigger(cross, first.state, {}, 2_000);
		const duplicate = transitionTrigger(cross, unknown.state, facts, 3_000);
		expect(first.shouldFire).toBe(true);
		expect(unknown.state.armed).toBe(false);
		expect(duplicate.shouldFire).toBe(false);
	});

	it("fails closed for invalid policies and rejects excessive change windows", () => {
		expect(
			transitionTrigger(
				{ ...definition(), policy: { mode: "while_true", cooldownSec: Number.NaN } },
				base,
				facts,
				1_000,
			).evaluation,
		).toMatchObject({ state: "unknown", reason: "invalid cooldown" });
		expect(
			transitionTrigger({ ...definition(), policy: { mode: "once", expiresAt: "not-a-date" } }, base, facts, 1_000)
				.evaluation,
		).toMatchObject({ state: "unknown", reason: "invalid expiry" });
		expect(() =>
			validateCondition({
				kind: "change",
				fact: { key: "price" },
				windowSec: MAX_CHANGE_WINDOW_SEC + 1,
				operator: "gt",
				value: 1,
				unit: "absolute",
			}),
		).toThrow();
	});

	it("preserves nested stable_for state through trigger transitions", () => {
		const d: TriggerDefinition = {
			id: "nested",
			name: "nested",
			when: {
				kind: "all",
				conditions: [
					{
						kind: "stable_for",
						condition: { kind: "compare", fact: { key: "price" }, operator: "gt", value: 100 },
						durationSec: 10,
					},
					{
						kind: "stable_for",
						condition: { kind: "compare", fact: { key: "volume" }, operator: "gt", value: 1 },
						durationSec: 20,
					},
				],
			},
			// biome-ignore lint/suspicious/noThenProperty: `then` is the public trigger action field.
			then: { kind: "notify", message: "hit" },
			policy: { mode: "once" },
		};
		const state: RuntimeState = { status: "active", armed: true };
		const at = (time: number) => ({
			price: { value: 101, observedAt: time },
			volume: { value: 2, observedAt: time },
		});
		const first = transitionTrigger(d, state, at(1_000), 1_000);
		const second = transitionTrigger(d, first.state, at(11_000), 11_000);
		const third = transitionTrigger(d, second.state, at(21_000), 21_000);
		expect(first.shouldFire).toBe(false);
		expect(second.shouldFire).toBe(false);
		expect(third.shouldFire).toBe(true);
		expect(third.state.status).toBe("fired");
	});

	it("validates every field and limits nesting", () => {
		expect(() =>
			validateCondition({
				kind: "change",
				fact: { key: "" },
				windowSec: 0,
				operator: "gt",
				value: Infinity,
				unit: "bad",
			}),
		).toThrow();
		expect(() => validateCondition({ kind: "all", conditions: [] })).toThrow();
		expect(() =>
			validateTriggerDefinition({
				id: "",
				name: "x",
				when: { kind: "time", at: "bad" },
				// biome-ignore lint/suspicious/noThenProperty: `then` is the public trigger action field.
				then: { kind: "notify", message: "" },
			}),
		).toThrow();
	});

	it("counts time leaves in the atomic condition limit", () => {
		const branch = {
			kind: "all",
			conditions: Array.from({ length: 10 }, () => ({ kind: "time", at: "2026-01-01" })),
		};
		expect(() => validateCondition({ kind: "all", conditions: [branch, branch, branch] })).not.toThrow();
		expect(() => validateCondition({ kind: "all", conditions: [branch, branch, branch, branch] })).toThrow(
			"too many",
		);
	});

	it("rejects invalid clocks and unavailable percent-change denominators", () => {
		expect(() => evaluateCondition(definition().when, facts, Number.NaN)).toThrow("time must be finite");
		expect(
			evaluateCondition(
				{
					kind: "change",
					fact: { key: "price" },
					windowSec: 60,
					operator: "gt",
					value: 0,
					unit: "percent",
				},
				{ price: { value: 10, observedAt: 61_000, history: [{ value: 0, observedAt: 1000 }] } },
				61_000,
			).state,
		).toBe("unknown");
	});
});
