import { type TSchema, Type } from "typebox";
import { type Condition, MAX_CHANGE_WINDOW_SEC, type TriggerDefinition } from "./model.ts";

const compareOperators = ["eq", "neq", "gt", "gte", "lt", "lte"];

// TypeBox 1.x has no recursive builder, so the recursive condition schema is
// expressed as a JSON Schema definition referenced through `$ref`. `Check()`
// resolves the reference both when `conditionSchema` is the root document and
// when it is embedded as `triggerSchema.when`. The schema enforces structure
// only; `validateCondition` additionally enforces the nesting-depth and
// atomic-condition budgets, and value semantics such as date parseability.
const factSchema = { type: "object", properties: { key: { type: "string", minLength: 1 } }, required: ["key"] };
const compareOperatorSchema = { enum: compareOperators };

const conditionDefinition = {
	anyOf: [
		{
			type: "object",
			properties: { kind: { const: "time" }, at: { type: "string", minLength: 1 } },
			required: ["kind", "at"],
		},
		{
			type: "object",
			properties: {
				kind: { const: "compare" },
				fact: factSchema,
				operator: compareOperatorSchema,
				value: { anyOf: [{ type: "number" }, { type: "string" }, { type: "boolean" }] },
			},
			required: ["kind", "fact", "operator", "value"],
		},
		{
			type: "object",
			properties: {
				kind: { const: "cross" },
				fact: factSchema,
				direction: { enum: ["above", "below"] },
				value: { type: "number" },
			},
			required: ["kind", "fact", "direction", "value"],
		},
		{
			type: "object",
			properties: {
				kind: { const: "change" },
				fact: factSchema,
				windowSec: { type: "number", exclusiveMinimum: 0, maximum: MAX_CHANGE_WINDOW_SEC },
				operator: compareOperatorSchema,
				value: { type: "number" },
				unit: { enum: ["absolute", "percent"] },
			},
			required: ["kind", "fact", "windowSec", "operator", "value", "unit"],
		},
		{
			type: "object",
			properties: {
				kind: { enum: ["all", "any"] },
				conditions: { type: "array", items: { $ref: "#/$defs/condition" }, minItems: 1, maxItems: 10 },
			},
			required: ["kind", "conditions"],
		},
		{
			type: "object",
			properties: { kind: { const: "not" }, condition: { $ref: "#/$defs/condition" } },
			required: ["kind", "condition"],
		},
		{
			type: "object",
			properties: {
				kind: { const: "stable_for" },
				condition: { $ref: "#/$defs/condition" },
				durationSec: { type: "number", exclusiveMinimum: 0 },
			},
			required: ["kind", "condition", "durationSec"],
		},
	],
};

export const conditionSchema: TSchema = Type.Unsafe<Condition>({
	$defs: { condition: conditionDefinition },
	$ref: "#/$defs/condition",
});

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Invalid trigger condition");
	return value as Record<string, unknown>;
}
function finite(value: unknown, name: string): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be finite`);
}
function fact(value: unknown): void {
	const ref = record(value);
	if (typeof ref.key !== "string" || ref.key.trim() === "") throw new Error("Fact key must be non-empty");
}
function date(value: unknown, name: string): void {
	if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Date.parse(value)))
		throw new Error(`${name} must be a valid date`);
}

export function validateCondition(value: unknown, depth = 0, atoms = { count: 0 }): void {
	if (depth > 5) throw new Error("Trigger condition nesting is too deep");
	const condition = record(value);
	if (typeof condition.kind !== "string") throw new Error("Condition kind is required");
	switch (condition.kind) {
		case "time":
			date(condition.at, "Condition time");
			break;
		case "compare":
			fact(condition.fact);
			if (typeof condition.operator !== "string" || !compareOperators.includes(condition.operator))
				throw new Error("Invalid compare operator");
			if (!["number", "string", "boolean"].includes(typeof condition.value))
				throw new Error("Invalid compare value");
			if (typeof condition.value === "number") finite(condition.value, "Compare value");
			break;
		case "cross":
		case "change":
			fact(condition.fact);
			finite(condition.value, "Condition value");
			if (condition.kind === "cross") {
				if (condition.direction !== "above" && condition.direction !== "below")
					throw new Error("Invalid cross direction");
			} else {
				if (
					typeof condition.windowSec !== "number" ||
					!Number.isFinite(condition.windowSec) ||
					condition.windowSec <= 0
				)
					throw new Error("Change windowSec must be positive");
				if (condition.windowSec > MAX_CHANGE_WINDOW_SEC)
					throw new Error(`Change windowSec must not exceed ${MAX_CHANGE_WINDOW_SEC}`);
				if (condition.unit !== "absolute" && condition.unit !== "percent") throw new Error("Invalid change unit");
				if (typeof condition.operator !== "string" || !compareOperators.includes(condition.operator))
					throw new Error("Invalid change operator");
			}
			break;
		case "all":
		case "any":
			if (
				!Array.isArray(condition.conditions) ||
				condition.conditions.length === 0 ||
				condition.conditions.length > 10
			)
				throw new Error("Logical condition must contain 1 to 10 conditions");
			for (const child of condition.conditions) validateCondition(child, depth + 1, atoms);
			return;
		case "not":
			validateCondition(condition.condition, depth + 1, atoms);
			return;
		case "stable_for":
			finite(condition.durationSec, "stable_for durationSec");
			if (condition.durationSec <= 0) throw new Error("stable_for durationSec must be positive");
			validateCondition(condition.condition, depth + 1, atoms);
			return;
		default:
			throw new Error(`Unsupported condition: ${condition.kind}`);
	}
	atoms.count++;
	if (atoms.count > 30) throw new Error("Trigger has too many atomic conditions");
}

export function validateTriggerDefinition(value: unknown): asserts value is TriggerDefinition {
	const trigger = record(value);
	if (typeof trigger.id !== "string" || trigger.id.trim() === "") throw new Error("Trigger id must be non-empty");
	if (typeof trigger.name !== "string" || trigger.name.trim() === "")
		throw new Error("Trigger name must be non-empty");
	validateCondition(trigger.when);
	const action = record(trigger.then);
	if (action.kind !== "notify" && action.kind !== "wake_agent") throw new Error("Invalid trigger action");
	if (typeof action.message !== "string" || action.message.trim() === "")
		throw new Error("Trigger message must be non-empty");
	if (trigger.policy !== undefined) {
		const policy = record(trigger.policy);
		if (policy.mode !== undefined && !["once", "on_edge", "while_true"].includes(String(policy.mode)))
			throw new Error("Invalid trigger mode");
		if (policy.cooldownSec !== undefined) {
			finite(policy.cooldownSec, "cooldownSec");
			if (policy.cooldownSec < 0) throw new Error("cooldownSec must not be negative");
		}
		if (policy.expiresAt !== undefined) date(policy.expiresAt, "expiresAt");
	}
}

export const triggerSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.String({ minLength: 1 }),
	when: conditionSchema,
	// biome-ignore lint/suspicious/noThenProperty: `then` is the public trigger action field.
	then: Type.Object({
		kind: Type.Union([Type.Literal("notify"), Type.Literal("wake_agent")]),
		message: Type.String({ minLength: 1 }),
	}),
	policy: Type.Optional(
		Type.Object({
			mode: Type.Optional(Type.Union([Type.Literal("once"), Type.Literal("on_edge"), Type.Literal("while_true")])),
			cooldownSec: Type.Optional(Type.Number({ minimum: 0 })),
			// Date parseability is enforced by validateTriggerDefinition; any
			// Date.parse-able string is accepted there, not only RFC 3339.
			expiresAt: Type.Optional(Type.String()),
		}),
	),
});
