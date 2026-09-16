import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { Condition, TriggerDefinition } from "./model.ts";
import { conditionSchema, triggerSchema } from "./schema.ts";

const definition = (when: Condition, policy?: TriggerDefinition["policy"]): TriggerDefinition => ({
	id: "t",
	name: "test",
	when,
	// biome-ignore lint/suspicious/noThenProperty: `then` is the public trigger action field.
	then: { kind: "notify", message: "hit" },
	...(policy ? { policy } : {}),
});

const nested: Condition = {
	kind: "not",
	condition: {
		kind: "any",
		conditions: [
			{ kind: "time", at: "2026-01-01T00:00:00Z" },
			{ kind: "stable_for", condition: { kind: "time", at: "2026-01-01T00:00:00Z" }, durationSec: 30 },
		],
	},
};

describe("trigger schemas", () => {
	it("validates recursive conditions through the $ref definition", () => {
		expect(Check(conditionSchema, nested)).toBe(true);
		expect(Check(triggerSchema, definition(nested))).toBe(true);
	});

	it("rejects unsupported kinds at any nesting depth", () => {
		expect(Check(conditionSchema, { kind: "nonsense" })).toBe(false);
		expect(Check(conditionSchema, { kind: "not", condition: { kind: "nonsense" } })).toBe(false);
		expect(Check(conditionSchema, { at: "2026-01-01T00:00:00Z" })).toBe(false);
		expect(Check(triggerSchema, definition({ kind: "nonsense" } as unknown as Condition))).toBe(false);
	});

	it("rejects structurally invalid atoms", () => {
		expect(Check(conditionSchema, { kind: "time", at: "" })).toBe(false);
		expect(Check(conditionSchema, { kind: "compare", fact: { key: "" }, operator: "gt", value: 1 })).toBe(false);
		expect(Check(conditionSchema, { kind: "compare", fact: { key: "price" }, operator: "zz", value: 1 })).toBe(false);
		expect(Check(conditionSchema, { kind: "compare", fact: { key: "price" }, operator: "gt", value: null })).toBe(
			false,
		);
		expect(Check(conditionSchema, { kind: "cross", fact: { key: "price" }, direction: "sideways", value: 1 })).toBe(
			false,
		);
		expect(
			Check(conditionSchema, {
				kind: "change",
				fact: { key: "price" },
				windowSec: 0,
				operator: "gt",
				value: 1,
				unit: "absolute",
			}),
		).toBe(false);
		expect(
			Check(conditionSchema, {
				kind: "change",
				fact: { key: "price" },
				windowSec: 3601,
				operator: "gt",
				value: 1,
				unit: "absolute",
			}),
		).toBe(false);
		expect(Check(conditionSchema, { kind: "all", conditions: [] })).toBe(false);
		expect(
			Check(conditionSchema, {
				kind: "all",
				conditions: Array.from({ length: 11 }, () => ({ kind: "time", at: "2026-01-01" })),
			}),
		).toBe(false);
		expect(Check(conditionSchema, { kind: "stable_for", condition: { kind: "time", at: "x" }, durationSec: 0 })).toBe(
			false,
		);
	});

	it("accepts every Date.parse-able expiry like the manual validator", () => {
		expect(Check(triggerSchema, definition({ kind: "time", at: "x" }, { expiresAt: "1 Sep 2026" }))).toBe(true);
		expect(Check(triggerSchema, definition({ kind: "time", at: "x" }, { expiresAt: "not-a-date" }))).toBe(true);
	});

	it("rejects invalid trigger envelopes", () => {
		const when: Condition = { kind: "time", at: "x" };
		expect(Check(triggerSchema, { ...definition(when), id: "" })).toBe(false);
		expect(Check(triggerSchema, { ...definition(when), name: "" })).toBe(false);
		expect(
			Check(
				triggerSchema,
				// biome-ignore lint/suspicious/noThenProperty: `then` is the public trigger action field.
				{ ...definition(when), then: { kind: "notify", message: "" } },
			),
		).toBe(false);
		expect(
			Check(
				triggerSchema,
				// biome-ignore lint/suspicious/noThenProperty: `then` is the public trigger action field.
				{ ...definition(when), then: { kind: "shout", message: "x" } },
			),
		).toBe(false);
		expect(
			Check(
				triggerSchema,
				definition(when, { mode: "forever" as unknown as NonNullable<TriggerDefinition["policy"]>["mode"] }),
			),
		).toBe(false);
	});
});
