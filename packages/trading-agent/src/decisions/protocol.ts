import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { canonicalTime, identifierSchema, scopeSchema } from "../plans/model.ts";

const timestamp = Type.String({ minLength: 1, maxLength: 40 });
export const studyConfigSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 120 }),
		symbols: Type.Array(Type.String({ pattern: "^[A-Z0-9_-]+/[A-Z0-9_-]+$", maxLength: 80 }), {
			minItems: 1,
			maxItems: 20,
			uniqueItems: true,
		}),
		horizonSeconds: Type.Integer({ minimum: 60, maximum: 2_592_000 }),
		maxSourceAgeSeconds: Type.Integer({ minimum: 1, maximum: 300 }),
		endpointWindowSeconds: Type.Integer({ minimum: 5, maximum: 900 }),
		feeBpsPerSide: Type.Number({ minimum: 0, maximum: 1000 }),
		slippageBpsPerSide: Type.Number({ minimum: 0, maximum: 1000 }),
		minimumSamples: Type.Integer({ minimum: 20, maximum: 10_000 }),
	},
	{ additionalProperties: false },
);
export type StudyConfig = Static<typeof studyConfigSchema>;

export const studySchema = Type.Object(
	{
		id: identifierSchema,
		version: Type.Literal(1),
		scope: scopeSchema,
		epoch: Type.Integer({ minimum: 0 }),
		confirmedAt: timestamp,
		confirmedBy: Type.Literal("operator"),
		config: studyConfigSchema,
		digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		stoppedAt: Type.Optional(timestamp),
	},
	{ additionalProperties: false },
);
export type DecisionStudy = Static<typeof studySchema>;

export const endpointSchema = Type.Object(
	{
		at: timestamp,
		sourceAt: timestamp,
		price: Type.Number({ exclusiveMinimum: 0 }),
		symbol: Type.String(),
		scope: scopeSchema,
		source: Type.Literal("marketData.getTicker"),
		sourceTimestampKnown: Type.Literal(true),
	},
	{ additionalProperties: false },
);
export type DecisionEndpoint = Static<typeof endpointSchema>;

export const enrollmentSchema = Type.Object(
	{
		version: Type.Literal(1),
		studyId: identifierSchema,
		dueAt: timestamp,
		deadlineAt: timestamp,
		entryObservationId: Type.Optional(identifierSchema),
		gap: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
	},
	{ additionalProperties: false },
);
export type DecisionEnrollment = Static<typeof enrollmentSchema>;
export const outcomeSchema = Type.Object(
	{
		claimId: identifierSchema,
		turnId: identifierSchema,
		studyId: identifierSchema,
		status: Type.Union([Type.Literal("observed"), Type.Literal("missing")]),
		at: timestamp,
		endpoint: Type.Optional(endpointSchema),
		reason: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
	},
	{ additionalProperties: false },
);
export type DecisionOutcome = Static<typeof outcomeSchema>;
export const attemptSchema = Type.Object(
	{
		claimId: identifierSchema,
		at: timestamp,
		count: Type.Integer({ minimum: 1, maximum: 100 }),
		reason: Type.String({ minLength: 1, maxLength: 100 }),
	},
	{ additionalProperties: false },
);

export function validateStudyConfig(value: unknown): asserts value is StudyConfig {
	if (!Check(studyConfigSchema, value) || value.endpointWindowSeconds > value.horizonSeconds)
		throw new Error("Invalid study configuration; endpoint window must not exceed the numeric horizon");
}

export function studyDigest(study: Pick<DecisionStudy, "scope" | "epoch" | "confirmedAt" | "config">): string {
	const { scope, epoch, confirmedAt, config } = study;
	return createHash("sha256")
		.update(
			JSON.stringify([
				1,
				[scope.accountId, scope.exchange, scope.mode, scope.marketType, scope.quoteCurrency, scope.positionMode],
				epoch,
				confirmedAt,
				[
					config.name,
					config.symbols,
					config.horizonSeconds,
					config.maxSourceAgeSeconds,
					config.endpointWindowSeconds,
					config.feeBpsPerSide,
					config.slippageBpsPerSide,
					config.minimumSamples,
				],
				"first-valid-ticker-within-fixed-window",
				"cited-pre-decision-entry-only",
				"spot-long-or-cash-unit-notional",
			]),
		)
		.digest("hex");
}

export function validateStudy(study: DecisionStudy): void {
	validateStudyConfig(study.config);
	if (
		!canonicalTime(study.confirmedAt) ||
		(study.stoppedAt && (!canonicalTime(study.stoppedAt) || study.stoppedAt < study.confirmedAt)) ||
		study.digest !== studyDigest(study)
	)
		throw new Error("Invalid or modified frozen decision protocol");
	if (study.config.symbols.some((symbol) => symbol.split("/")[1] !== study.scope.quoteCurrency))
		throw new Error("Study symbols must use the execution scope quote currency");
}
