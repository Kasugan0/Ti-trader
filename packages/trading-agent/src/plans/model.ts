import type { ExecutionRecord, ExecutionScope } from "@nikopack/ti-trading-engine";
import { isExecutionJournalState } from "@nikopack/ti-trading-engine";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { type MonitoringState, validateMonitoringState } from "../monitoring-state.ts";
import { normalizedPlanIntent, planIntentFingerprint } from "./intent.ts";

export const PLAN_LIMITS = { active: 20, plans: 500, versions: 100, notes: 200, events: 1000, bytes: 32 * 1024 * 1024 };
export const PLAN_MAX_AGE_MS = 5 * 60_000;
export const identifierSchema = Type.String({ pattern: "^[A-Za-z0-9_-]{1,80}$" });
export const scopeSchema = Type.Object(
	{
		accountId: identifierSchema,
		exchange: identifierSchema,
		mode: Type.Union([Type.Literal("paper"), Type.Literal("live")]),
		marketType: Type.Union([Type.Literal("spot"), Type.Literal("usdm-futures"), Type.Literal("both")]),
		quoteCurrency: Type.String({ pattern: "^[A-Z0-9_-]+$" }),
		positionMode: Type.Union([Type.Literal("one-way"), Type.Literal("hedge")]),
	},
	{ additionalProperties: false },
);
const time = Type.String({ minLength: 1, maxLength: 40 });
const text = Type.String({ minLength: 1, maxLength: 4096 });
export const planConditionSchema = Type.Object(
	{
		fact: Type.Union([Type.Literal("price"), Type.Literal("closed_price")]),
		operator: Type.Union([Type.Literal("gt"), Type.Literal("gte"), Type.Literal("lt"), Type.Literal("lte")]),
		value: Type.Number({ exclusiveMinimum: 0 }),
	},
	{ additionalProperties: false },
);
export const planContentSchema = Type.Object(
	{
		symbol: Type.String({ minLength: 3, maxLength: 80 }),
		timeframe: Type.Union([
			Type.Literal("1m"),
			Type.Literal("5m"),
			Type.Literal("15m"),
			Type.Literal("1h"),
			Type.Literal("4h"),
			Type.Literal("1d"),
		]),
		direction: Type.Union([Type.Literal("long"), Type.Literal("short"), Type.Literal("observe")]),
		thesis: text,
		entry: Type.Array(planConditionSchema, { minItems: 1, maxItems: 8 }),
		invalidation: Type.Array(planConditionSchema, { minItems: 1, maxItems: 8 }),
		expiresAt: time,
		reviewAt: time,
		risk: text,
		proposedSizeNotes: Type.Optional(text),
		proposedStopNotes: Type.Optional(text),
		evidence: Type.Array(
			Type.Object(
				{
					source: Type.String({ minLength: 1, maxLength: 300 }),
					reference: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
					observedAt: time,
					summary: text,
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 12 },
		),
	},
	{ additionalProperties: false },
);
export type PlanContent = Static<typeof planContentSchema>;
export type PlanCondition = Static<typeof planConditionSchema>;
const triState = Type.Union([Type.Literal("true"), Type.Literal("false"), Type.Literal("unknown")]);
export const observationSchema = Type.Object(
	{
		version: Type.Integer({ minimum: 1 }),
		at: time,
		entry: triState,
		invalidation: triState,
		expired: Type.Boolean(),
		reviewDue: Type.Boolean(),
		facts: Type.Array(
			Type.Object({
				fact: Type.Union([Type.Literal("price"), Type.Literal("closed_price")]),
				value: Type.Number({ exclusiveMinimum: 0 }),
				observedAt: Type.Number({ minimum: 0 }),
			}),
			{ maxItems: 2 },
		),
		limitations: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 10 }),
	},
	{ additionalProperties: false },
);
export type PlanObservation = Static<typeof observationSchema>;
export const accountObservationSchema = Type.Object(
	{
		version: Type.Integer({ minimum: 1 }),
		at: time,
		status: Type.Union([Type.Literal("observed"), Type.Literal("unknown")]),
		orders: Type.Array(
			Type.Object(
				{
					executionId: identifierSchema,
					id: identifierSchema,
					status: Type.String({ maxLength: 40 }),
					filled: Type.Number({ minimum: 0 }),
					remaining: Type.Number({ minimum: 0 }),
				},
				{ additionalProperties: false },
			),
			{ maxItems: 2000 },
		),
		protection: Type.Union([
			Type.Literal("protected"),
			Type.Literal("partial"),
			Type.Literal("none"),
			Type.Literal("unknown"),
			Type.Literal("no-position"),
		]),
		positions: Type.Array(
			Type.Object(
				{
					side: Type.String({ maxLength: 10 }),
					amount: Type.Number(),
					protection: Type.String({ maxLength: 20 }),
				},
				{ additionalProperties: false },
			),
			{ maxItems: 4 },
		),
		limitations: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 20 }),
	},
	{ additionalProperties: false },
);
export type PlanAccountObservation = Static<typeof accountObservationSchema>;
const planSchema = Type.Object({
	id: identifierSchema,
	scope: scopeSchema,
	revision: Type.Integer({ minimum: 1 }),
	status: Type.Union([Type.Literal("draft"), Type.Literal("tracking"), Type.Literal("archived")]),
	activeVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
	versions: Type.Array(
		Type.Object({
			version: Type.Integer({ minimum: 1 }),
			epoch: Type.Integer({ minimum: 0 }),
			at: time,
			content: planContentSchema,
		}),
		{ minItems: 1, maxItems: PLAN_LIMITS.versions },
	),
	notes: Type.Array(
		Type.Object({ at: time, author: Type.Union([Type.Literal("model"), Type.Literal("operator")]), text }),
		{ maxItems: PLAN_LIMITS.notes },
	),
	observation: Type.Optional(observationSchema),
	accountObservation: Type.Optional(accountObservationSchema),
	events: Type.Array(
		Type.Object({
			id: identifierSchema,
			at: time,
			version: Type.Integer({ minimum: 1 }),
			kind: Type.String({ maxLength: 80 }),
			detail: Type.String({ maxLength: 1000 }),
		}),
		{ maxItems: PLAN_LIMITS.events },
	),
	intents: Type.Array(
		Type.Object({
			id: identifierSchema,
			version: Type.Integer({ minimum: 1 }),
			engineIntentId: identifierSchema,
			fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
			proposal: Type.String({ minLength: 1, maxLength: 4096 }),
			at: time,
		}),
		{ maxItems: PLAN_LIMITS.events },
	),
	executions: Type.Array(
		Type.Object({
			record: Type.Unsafe<ExecutionRecord>({ type: "object" }),
			fee: Type.Optional(Type.Number()),
		}),
		{ maxItems: PLAN_LIMITS.events },
	),
});
export type TradePlan = Static<typeof planSchema>;
const stateSchema = Type.Object(
	{
		version: Type.Literal(1),
		epochs: Type.Record(Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Integer({ minimum: 0 })),
		monitoring: Type.Optional(Type.Unsafe<MonitoringState>({ type: "object" })),
		queryOffsets: Type.Optional(
			Type.Record(Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Integer({ minimum: 0 })),
		),
		plans: Type.Array(planSchema, { maxItems: PLAN_LIMITS.plans }),
	},
	{ additionalProperties: false },
);
export type PlanState = Static<typeof stateSchema>;
const intentProposalSchema = Type.Object({
	intent: Type.Object({
		kind: Type.Union([Type.Literal("order"), Type.Literal("oco")]),
		input: Type.Record(Type.String(), Type.Unknown()),
		replacementIds: Type.Optional(Type.Array(identifierSchema)),
	}),
});

export function planExecutionMatchesProposal(proposal: string, record: ExecutionRecord): boolean {
	const parsed: unknown = JSON.parse(proposal);
	return (
		Check(intentProposalSchema, parsed) &&
		normalizedPlanIntent(parsed.intent) ===
			normalizedPlanIntent({ ...record.intent, input: { ...record.intent.input } })
	);
}

export function canonicalTime(value: string): boolean {
	return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function validatePlanContent(value: unknown): asserts value is PlanContent {
	if (!Check(planContentSchema, value) || Buffer.byteLength(JSON.stringify(value), "utf8") > 8192)
		throw new Error("Invalid plan content or content exceeds 8 KiB");
	if (!canonicalTime(value.expiresAt) || !canonicalTime(value.reviewAt) || value.reviewAt > value.expiresAt)
		throw new Error("Plan review and expiry must be ordered ISO UTC timestamps");
	for (const evidence of value.evidence)
		if (!canonicalTime(evidence.observedAt)) throw new Error("Invalid plan evidence timestamp");
}

export function validatePlanState(value: unknown): asserts value is PlanState {
	if (!Check(stateSchema, value)) throw new Error("Invalid plan state; refusing to replace it with empty plans");
	if (value.monitoring !== undefined) validateMonitoringState(value.monitoring);
	const ids = new Set<string>();
	for (const plan of value.plans) {
		if (ids.has(plan.id)) throw new Error("Duplicate plan identity");
		ids.add(plan.id);
		for (const [index, version] of plan.versions.entries()) {
			validatePlanContent(version.content);
			if (
				version.version !== index + 1 ||
				!canonicalTime(version.at) ||
				version.content.symbol !== plan.versions[0].content.symbol
			)
				throw new Error("Invalid plan version history");
		}
		if (plan.activeVersion !== null && !plan.versions[plan.activeVersion - 1])
			throw new Error("Invalid active plan version");
		if (plan.status === "tracking" && plan.activeVersion === null)
			throw new Error("Tracked plan has no approved version");
		for (const entry of [...plan.notes, ...plan.events, ...plan.intents])
			if (!canonicalTime(entry.at)) throw new Error("Invalid plan event time");
		if (
			new Set(plan.events.map((event) => event.id)).size !== plan.events.length ||
			new Set(plan.intents.map((intent) => `${intent.version}:${intent.id}`)).size !== plan.intents.length
		)
			throw new Error("Duplicate plan event or intent");
		for (const entry of [...plan.events, ...plan.intents])
			if (!plan.versions[entry.version - 1]) throw new Error("Plan event references a missing version");
		for (const intent of plan.intents) {
			if (planIntentFingerprint(JSON.parse(intent.proposal)) !== intent.fingerprint)
				throw new Error("Plan intent fingerprint does not match its original proposal");
		}
		if (
			plan.observation &&
			(!canonicalTime(plan.observation.at) ||
				plan.observation.version !== plan.activeVersion ||
				new Set(plan.observation.facts.map((fact) => fact.fact)).size !== plan.observation.facts.length)
		)
			throw new Error("Invalid plan observation");
		if (
			plan.accountObservation &&
			(!canonicalTime(plan.accountObservation.at) || plan.accountObservation.version !== plan.activeVersion)
		)
			throw new Error("Invalid plan account observation");
		for (const { record } of plan.executions) {
			if (!isExecutionJournalState({ version: 1, records: [record] }))
				throw new Error("Invalid archived execution evidence");
			if (
				!sameScope(record.scope, plan.scope) ||
				record.reference?.kind !== "trade-plan" ||
				record.reference.id !== plan.id ||
				!plan.intents.some(
					(intent) =>
						intent.engineIntentId === record.intentId &&
						intent.version === record.reference?.version &&
						planExecutionMatchesProposal(intent.proposal, record),
				)
			)
				throw new Error("Execution is not correlated to this plan");
		}
	}
}

export function sameScope(left: ExecutionScope, right: ExecutionScope): boolean {
	return (
		Object.keys(left).length === Object.keys(right).length &&
		left.accountId === right.accountId &&
		left.exchange === right.exchange &&
		left.mode === right.mode &&
		left.marketType === right.marketType &&
		left.quoteCurrency === right.quoteCurrency &&
		left.positionMode === right.positionMode
	);
}
