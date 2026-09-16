import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExecutionScope } from "@nikopack/ti-trading-engine";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { AGENT_DIR } from "../config.ts";
import { canonicalTime, identifierSchema, sameScope, scopeSchema } from "../plans/model.ts";
import { PrivateStore } from "../private-store.ts";
import { evaluateStrategy } from "./evaluation.ts";
import {
	attemptSchema,
	type DecisionEndpoint,
	type DecisionOutcome,
	type DecisionStudy,
	enrollmentSchema,
	outcomeSchema,
	type StudyConfig,
	studyDigest,
	studySchema,
	validateStudy,
	validateStudyConfig,
} from "./protocol.ts";

const stamp = Type.String({ minLength: 1, maxLength: 40 });
export const decisionSchema = Type.Object(
	{
		action: Type.Union([
			Type.Literal("wait"),
			Type.Literal("hold"),
			Type.Literal("enter"),
			Type.Literal("reduce"),
			Type.Literal("exit"),
			Type.Literal("avoid"),
		]),
		symbol: Type.Optional(Type.String({ pattern: "^[A-Z0-9_-]+/[A-Z0-9_-]+(?::[A-Z0-9_-]+)?$" })),
		rationale: Type.String({ minLength: 1, maxLength: 2000 }),
		invalidation: Type.String({ minLength: 1, maxLength: 1000 }),
		horizon: Type.String({ minLength: 1, maxLength: 200 }),
		uncertainties: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 10 }),
		observations: Type.Array(identifierSchema, { maxItems: 30, uniqueItems: true }),
		forecast: Type.Optional(
			Type.Object(
				{ direction: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("flat")]) },
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);
export type DecisionClaim = Static<typeof decisionSchema>;
const observationSchema = Type.Object({
	id: identifierSchema,
	tool: identifierSchema,
	at: stamp,
	sourceAt: Type.Union([stamp, Type.Null()]),
	sourceTimeVerified: Type.Optional(Type.Boolean()),
	scope: Type.Optional(scopeSchema),
	symbol: Type.Optional(Type.String({ maxLength: 80 })),
	status: Type.Union([Type.Literal("observed"), Type.Literal("partial"), Type.Literal("error")]),
	snapshot: Type.Record(Type.String(), Type.Union([Type.Number(), Type.Null()])),
	digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
});
const mutationSchema = Type.Object({
	id: identifierSchema,
	tool: identifierSchema,
	at: stamp,
	symbol: Type.Optional(Type.String({ maxLength: 80 })),
	decisionIds: Type.Array(identifierSchema, { maxItems: 30 }),
	outcome: Type.Union([
		Type.Literal("pending"),
		Type.Literal("request-completed"),
		Type.Literal("blocked"),
		Type.Literal("unknown"),
		Type.Literal("cancelled"),
		Type.Literal("error"),
	]),
	executionId: Type.Optional(identifierSchema),
});
const turnSchema = Type.Object({
	id: identifierSchema,
	scope: scopeSchema,
	epoch: Type.Optional(Type.Integer({ minimum: 0 })),
	at: stamp,
	endedAt: Type.Optional(stamp),
	model: Type.String({ minLength: 1, maxLength: 200 }),
	provider: Type.String({ minLength: 1, maxLength: 100 }),
	fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	captureComplete: Type.Boolean(),
	studyId: Type.Optional(identifierSchema),
	activeToolsComplete: Type.Optional(Type.Boolean()),
	status: Type.Union([
		Type.Literal("active"),
		Type.Literal("finished"),
		Type.Literal("interrupted"),
		Type.Literal("failed"),
	]),
	observations: Type.Array(observationSchema, { maxItems: 100 }),
	claims: Type.Array(
		Type.Object({
			id: identifierSchema,
			at: stamp,
			beforeMutation: Type.Boolean(),
			claim: decisionSchema,
			evaluation: Type.Optional(enrollmentSchema),
		}),
		{ maxItems: 30 },
	),
	mutations: Type.Array(mutationSchema, { maxItems: 100 }),
});
export type DecisionTurn = Static<typeof turnSchema>;
export const decisionExportSchema = Type.Object(
	{
		version: Type.Literal(1),
		turns: Type.Array(turnSchema, { maxItems: 1000 }),
		studies: Type.Optional(Type.Array(studySchema, { maxItems: 100 })),
		outcomes: Type.Optional(Type.Array(outcomeSchema, { maxItems: 30_000 })),
		attempts: Type.Optional(Type.Array(attemptSchema, { maxItems: 30_000 })),
	},
	{ additionalProperties: false },
);
export type DecisionEvidence = Static<typeof decisionExportSchema>;

export function validateDecisionEvidence(value: unknown): asserts value is DecisionEvidence {
	if (!Check(decisionExportSchema, value)) throw new Error("Invalid decision evidence");
	const ids = new Set<string>();
	const claimIds = new Set<string>();
	const studies = new Map((value.studies ?? []).map((study) => [study.id, study]));
	if (studies.size !== (value.studies ?? []).length) throw new Error("Duplicate study identity");
	for (const study of studies.values()) validateStudy(study);
	const activeScopes = new Set<string>();
	for (const study of studies.values()) {
		if (study.stoppedAt) continue;
		const key = JSON.stringify(Object.entries(study.scope).sort(([a], [b]) => a.localeCompare(b)));
		if (activeScopes.has(key)) throw new Error("Multiple active studies for one scope");
		activeScopes.add(key);
	}
	for (const turn of value.turns) {
		if (
			ids.has(turn.id) ||
			!canonicalTime(turn.at) ||
			(turn.endedAt && (!canonicalTime(turn.endedAt) || turn.endedAt < turn.at))
		)
			throw new Error("Invalid decision identity or time");
		ids.add(turn.id);
		const entries = [...turn.observations, ...turn.claims, ...turn.mutations];
		if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
			throw new Error("Duplicate decision evidence identity");
		for (const entry of entries)
			if (!canonicalTime(entry.at) || entry.at < turn.at || (turn.endedAt && entry.at > turn.endedAt))
				throw new Error("Invalid decision event chronology");
		for (const source of turn.observations)
			if (source.sourceAt !== null && !canonicalTime(source.sourceAt)) throw new Error("Invalid source time");
		const study = turn.studyId ? studies.get(turn.studyId) : undefined;
		if (
			turn.studyId &&
			(!study ||
				!sameScope(study.scope, turn.scope) ||
				study.epoch !== (turn.epoch ?? 0) ||
				study.confirmedAt > turn.at)
		)
			throw new Error("Decision turn has no prospective scope-matched protocol");
		for (const claim of turn.claims) {
			if (claimIds.has(claim.id)) throw new Error("Duplicate claim identity");
			claimIds.add(claim.id);
			const evaluation = claim.evaluation;
			if (!evaluation) continue;
			if (
				!study ||
				evaluation.studyId !== study.id ||
				evaluation.dueAt !== new Date(Date.parse(claim.at) + study.config.horizonSeconds * 1000).toISOString() ||
				evaluation.deadlineAt !==
					new Date(Date.parse(evaluation.dueAt) + study.config.endpointWindowSeconds * 1000).toISOString() ||
				(study.stoppedAt && claim.at > study.stoppedAt) ||
				(!evaluation.entryObservationId && !evaluation.gap)
			)
				throw new Error("Invalid frozen prospective enrollment");
			if (evaluation.entryObservationId) {
				const entry = turn.observations.find((observation) => observation.id === evaluation.entryObservationId);
				if (
					!entry ||
					!claim.claim.observations.includes(entry.id) ||
					entry.tool !== "get_price" ||
					entry.symbol !== claim.claim.symbol ||
					entry.at > claim.at ||
					entry.sourceAt === null ||
					entry.sourceTimeVerified !== true ||
					entry.sourceAt > entry.at ||
					!entry.scope ||
					!sameScope(entry.scope, turn.scope) ||
					entry.status !== "observed" ||
					typeof entry.snapshot.last !== "number" ||
					!Number.isFinite(entry.snapshot.last) ||
					entry.snapshot.last <= 0 ||
					Date.parse(claim.at) - Date.parse(entry.sourceAt) > study.config.maxSourceAgeSeconds * 1000
				)
					throw new Error("Invalid prospective entry observation");
			}
		}
		if ((turn.status === "active") !== (turn.endedAt === undefined)) throw new Error("Invalid decision lifecycle");
	}
	const outcomeIds = new Set<string>();
	const outcomeTurns = new Map(value.turns.map((turn) => [turn.id, turn]));
	for (const outcome of value.outcomes ?? []) {
		const turn = outcomeTurns.get(outcome.turnId);
		const claim = turn?.claims.find((entry) => entry.id === outcome.claimId);
		const enrollment = claim?.evaluation;
		const study = studies.get(outcome.studyId);
		if (
			outcomeIds.has(outcome.claimId) ||
			!turn ||
			!claim ||
			!enrollment ||
			!study ||
			enrollment.studyId !== study.id ||
			!canonicalTime(outcome.at) ||
			outcome.at < claim.at ||
			(outcome.status === "observed") !== (outcome.endpoint !== undefined) ||
			(outcome.status === "missing" && !outcome.reason)
		)
			throw new Error("Invalid decision outcome");
		outcomeIds.add(outcome.claimId);
		const endpoint = outcome.endpoint;
		if (
			endpoint &&
			(enrollment.gap ||
				!enrollment.entryObservationId ||
				!canonicalTime(endpoint.at) ||
				!canonicalTime(endpoint.sourceAt) ||
				endpoint.at !== outcome.at ||
				endpoint.sourceAt < enrollment.dueAt ||
				endpoint.sourceAt > endpoint.at ||
				endpoint.at > enrollment.deadlineAt ||
				Date.parse(endpoint.at) - Date.parse(endpoint.sourceAt) > study.config.maxSourceAgeSeconds * 1000 ||
				endpoint.symbol !== claim.claim.symbol ||
				!sameScope(endpoint.scope, turn.scope))
		)
			throw new Error("Outcome is outside its frozen source, scope or horizon window");
	}
	const attemptIds = new Set<string>();
	for (const attempt of value.attempts ?? []) {
		if (!claimIds.has(attempt.claimId) || attemptIds.has(attempt.claimId) || !canonicalTime(attempt.at))
			throw new Error("Invalid decision collection attempt");
		attemptIds.add(attempt.claimId);
	}
}

export class DecisionStore {
	readonly storage: PrivateStore<DecisionEvidence>;
	private readonly now: () => number;
	constructor(agentDir = AGENT_DIR, now: () => number = Date.now) {
		this.storage = new PrivateStore(
			join(agentDir, "decisions", "state.json"),
			() => ({ version: 1, turns: [] }),
			validateDecisionEvidence,
			32 * 1024 * 1024,
		);
		this.now = now;
	}
	list(scope: ExecutionScope): DecisionTurn[] {
		return this.storage.read().turns.filter((turn) => sameScope(turn.scope, scope));
	}
	evidence(scope: ExecutionScope): DecisionEvidence {
		const state = this.storage.read();
		const turns = state.turns.filter((turn) => sameScope(turn.scope, scope));
		const ids = new Set(turns.flatMap((turn) => turn.claims.map((claim) => claim.id)));
		return {
			version: 1,
			turns,
			studies: state.studies?.filter((study) => sameScope(study.scope, scope)),
			outcomes: state.outcomes?.filter((outcome) => ids.has(outcome.claimId)),
			attempts: state.attempts?.filter((attempt) => ids.has(attempt.claimId)),
		};
	}
	confirmStudy(scope: ExecutionScope, config: StudyConfig, epoch = 0): DecisionStudy {
		validateStudyConfig(config);
		return this.storage.transact((state) => {
			if (state.studies?.some((study) => !study.stoppedAt && sameScope(study.scope, scope)))
				throw new Error("Stop the active study before confirming a new immutable protocol");
			const base = {
				scope: structuredClone(scope),
				epoch,
				confirmedAt: new Date(this.now()).toISOString(),
				config: structuredClone(config),
			};
			const study: DecisionStudy = {
				...base,
				id: randomUUID(),
				version: 1,
				confirmedBy: "operator",
				digest: studyDigest(base),
			};
			state.studies ??= [];
			state.studies.push(study);
			return structuredClone(study);
		});
	}
	stopStudy(scope: ExecutionScope, id: string): void {
		this.storage.transact((state) => {
			const study = state.studies?.find((entry) => entry.id === id && sameScope(entry.scope, scope));
			if (!study) throw new Error("Study not found in current scope");
			study.stoppedAt ??= new Date(this.now()).toISOString();
		});
	}
	invalidateEpoch(scope: ExecutionScope, epoch: number): void {
		this.storage.transact((state) => {
			const invalid = new Set<string>();
			for (const study of state.studies ?? []) {
				if (!sameScope(study.scope, scope) || study.epoch === epoch) continue;
				study.stoppedAt ??= new Date(this.now()).toISOString();
				invalid.add(study.id);
			}
			const complete = new Set(state.outcomes?.map((outcome) => outcome.claimId));
			for (const turn of state.turns)
				for (const claim of turn.claims) {
					if (!claim.evaluation || !invalid.has(claim.evaluation.studyId) || complete.has(claim.id)) continue;
					state.outcomes ??= [];
					state.outcomes.push({
						claimId: claim.id,
						turnId: turn.id,
						studyId: claim.evaluation.studyId,
						status: "missing",
						at: new Date(this.now()).toISOString(),
						reason: "paper-reset-invalidated-study",
					});
				}
		});
	}
	start(
		scope: ExecutionScope,
		provider: string,
		model: string,
		fingerprint: string,
		activeToolsComplete = true,
		epoch = 0,
	): string {
		return this.storage.transact((state) => {
			if (state.turns.length >= 1000)
				throw new Error("Decision evidence capacity reached; export evidence and review retention limits");
			const id = randomUUID();
			const study = state.studies?.find(
				(entry) => !entry.stoppedAt && entry.epoch === epoch && sameScope(entry.scope, scope),
			);
			state.turns.push({
				id,
				scope: structuredClone(scope),
				epoch,
				at: new Date(this.now()).toISOString(),
				provider,
				model,
				fingerprint,
				captureComplete: true,
				activeToolsComplete,
				...(study ? { studyId: study.id } : {}),
				status: "active",
				observations: [],
				claims: [],
				mutations: [],
			});
			return id;
		});
	}
	update<R>(id: string, operation: (turn: DecisionTurn) => R): R {
		return this.storage.transact((state) => {
			const turn = state.turns.find((entry) => entry.id === id);
			if (!turn || turn.status !== "active") throw new Error("Decision turn is absent or sealed");
			const original = structuredClone(turn);
			const result = operation(turn);
			if (
				JSON.stringify([
					turn.id,
					turn.scope,
					turn.epoch,
					turn.at,
					turn.provider,
					turn.model,
					turn.fingerprint,
					turn.studyId,
					turn.activeToolsComplete,
				]) !==
					JSON.stringify([
						original.id,
						original.scope,
						original.epoch,
						original.at,
						original.provider,
						original.model,
						original.fingerprint,
						original.studyId,
						original.activeToolsComplete,
					]) ||
				JSON.stringify(turn.observations.slice(0, original.observations.length)) !==
					JSON.stringify(original.observations) ||
				JSON.stringify(turn.claims.slice(0, original.claims.length)) !== JSON.stringify(original.claims)
			)
				throw new Error("Original decision claims, scope, fingerprints and observations are immutable");
			return result;
		});
	}
	record(id: string, claim: DecisionClaim): string {
		if (!Check(decisionSchema, claim)) throw new Error("Invalid public decision");
		return this.storage.transact((state) => {
			const turn = state.turns.find((entry) => entry.id === id);
			if (!turn || turn.status !== "active") throw new Error("Decision turn is absent or sealed");
			const entryId = randomUUID();
			const at = new Date(this.now()).toISOString();
			const entry: DecisionTurn["claims"][number] = {
				id: entryId,
				at,
				beforeMutation: turn.mutations.length === 0,
				claim: structuredClone(claim),
			};
			const study = state.studies?.find((item) => item.id === turn.studyId && !item.stoppedAt);
			if (study) {
				const candidates = turn.observations
					.filter(
						(observation) =>
							claim.observations.includes(observation.id) &&
							observation.tool === "get_price" &&
							observation.status === "observed" &&
							observation.scope &&
							sameScope(observation.scope, turn.scope) &&
							observation.symbol === claim.symbol &&
							observation.at <= at &&
							observation.sourceAt !== null &&
							observation.sourceTimeVerified === true &&
							observation.sourceAt <= observation.at &&
							Date.parse(at) - Date.parse(observation.sourceAt) <= study.config.maxSourceAgeSeconds * 1000 &&
							typeof observation.snapshot.last === "number" &&
							Number.isFinite(observation.snapshot.last) &&
							observation.snapshot.last > 0,
					)
					.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
				const source = candidates[0];
				const gap = !entry.beforeMutation
					? "retrospective-claim"
					: !claim.symbol || !study.config.symbols.includes(claim.symbol)
						? "symbol-outside-protocol"
						: !source
							? "missing-trusted-prospective-entry"
							: undefined;
				entry.evaluation = {
					version: 1,
					studyId: study.id,
					dueAt: new Date(Date.parse(at) + study.config.horizonSeconds * 1000).toISOString(),
					deadlineAt: new Date(
						Date.parse(at) + (study.config.horizonSeconds + study.config.endpointWindowSeconds) * 1000,
					).toISOString(),
					...(gap ? { gap } : { entryObservationId: source.id }),
				};
				if (gap) {
					state.outcomes ??= [];
					state.outcomes.push({
						claimId: entryId,
						turnId: id,
						studyId: study.id,
						status: "missing",
						at,
						reason: gap,
					});
				}
			}
			turn.claims.push(entry);
			return entryId;
		});
	}
	completeOutcome(turnId: string, claimId: string, endpoint?: DecisionEndpoint, reason?: string): boolean {
		return this.completeOutcomes([{ turnId, claimId, endpoint, reason }]).length > 0;
	}
	completeOutcomes(
		inputs: Array<{ turnId: string; claimId: string; endpoint?: DecisionEndpoint; reason?: string }>,
	): DecisionOutcome[] {
		if (inputs.length > 100) throw new Error("Decision outcome batch exceeds capacity");
		if (!inputs.length) return [];
		return this.storage.transact((state) => {
			const completed = new Set(state.outcomes?.map((outcome) => outcome.claimId));
			const turns = new Map(state.turns.map((turn) => [turn.id, turn]));
			const added: DecisionOutcome[] = [];
			state.outcomes ??= [];
			for (const { turnId, claimId, endpoint, reason } of inputs) {
				if (completed.has(claimId)) continue;
				const claim = turns.get(turnId)?.claims.find((entry) => entry.id === claimId);
				if (!claim?.evaluation) throw new Error("No frozen enrollment for outcome");
				const outcome: DecisionOutcome = {
					turnId,
					claimId,
					studyId: claim.evaluation.studyId,
					at: endpoint?.at ?? new Date(this.now()).toISOString(),
					status: endpoint ? "observed" : "missing",
					...(endpoint ? { endpoint: structuredClone(endpoint) } : { reason: reason ?? "missing-endpoint" }),
				};
				state.outcomes.push(outcome);
				added.push(outcome);
				completed.add(claimId);
			}
			return structuredClone(added);
		});
	}
	recordAttempt(claimId: string, reason: string, increment = true): void {
		this.recordAttempts([{ claimId, reason }], increment);
	}
	recordAttempts(inputs: Array<{ claimId: string; reason: string }>, increment = true): void {
		if (inputs.length > 100) throw new Error("Decision attempt batch exceeds capacity");
		if (!inputs.length) return;
		this.storage.transact((state) => {
			const completed = new Set(state.outcomes?.map((outcome) => outcome.claimId));
			const attempts = new Map(state.attempts?.map((attempt) => [attempt.claimId, attempt]));
			for (const { claimId, reason } of inputs) {
				if (completed.has(claimId)) continue;
				const previous = attempts.get(claimId);
				if (previous) {
					previous.at = new Date(this.now()).toISOString();
					previous.count = Math.min(100, previous.count + (increment ? 1 : 0));
					previous.reason = reason;
				} else {
					state.attempts ??= [];
					const attempt = { claimId, at: new Date(this.now()).toISOString(), count: 1, reason };
					state.attempts.push(attempt);
					attempts.set(claimId, attempt);
				}
			}
		});
	}
	finish(id: string, status: "finished" | "interrupted" | "failed", captureComplete = true): void {
		this.update(id, (turn) => {
			turn.status = status;
			turn.endedAt = new Date(this.now()).toISOString();
			turn.captureComplete &&= captureComplete;
		});
	}
}

export function evidenceFingerprint(prompt: string, tools: unknown, version: string): string {
	return createHash("sha256")
		.update(JSON.stringify({ schema: 1, prompt, tools, version }))
		.digest("hex");
}

export function evaluateDecisions(evidence: DecisionEvidence, now = Date.now()) {
	validateDecisionEvidence(evidence);
	const cohorts = new Map<string, DecisionTurn[]>();
	for (const turn of evidence.turns) {
		const key = JSON.stringify([
			Object.entries(turn.scope).sort(([a], [b]) => a.localeCompare(b)),
			turn.epoch ?? null,
			turn.provider,
			turn.model,
			turn.fingerprint,
		]);
		const cohort = cohorts.get(key) ?? [];
		cohort.push(turn);
		cohorts.set(key, cohort);
	}
	const reports = [...cohorts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, turns]) => {
			let citations = 0;
			let invalidCitations = 0;
			let unknownFreshness = 0;
			let unknownScope = 0;
			let retrospectiveClaims = 0;
			let unrecordedMutations = 0;
			let nonTradingDecisions = 0;
			for (const turn of turns) {
				for (const claim of turn.claims) {
					if (!claim.beforeMutation) retrospectiveClaims++;
					if (["wait", "hold", "avoid"].includes(claim.claim.action)) nonTradingDecisions++;
					for (const id of claim.claim.observations) {
						citations++;
						const observation = turn.observations.find((entry) => entry.id === id);
						if (
							!observation ||
							observation.at > claim.at ||
							observation.status !== "observed" ||
							(observation.scope && !sameScope(observation.scope, turn.scope)) ||
							(observation.sourceAt !== null && observation.sourceAt > observation.at) ||
							(claim.claim.symbol && observation.symbol && observation.symbol !== claim.claim.symbol)
						) {
							invalidCitations++;
							continue;
						}
						if (!observation.scope) unknownScope++;
						if (
							observation.sourceAt === null ||
							(observation.tool === "get_price" && observation.sourceTimeVerified !== true)
						) {
							unknownFreshness++;
							continue;
						}
						const age = Date.parse(claim.at) - Date.parse(observation.sourceAt);
						if (age < 0 || age > 300_000) invalidCitations++;
					}
				}
				for (const mutation of turn.mutations) {
					if (
						!mutation.decisionIds.some((id) =>
							turn.claims.some(
								(claim) =>
									claim.id === id &&
									claim.at <= mutation.at &&
									["enter", "reduce", "exit"].includes(claim.claim.action) &&
									claim.claim.observations.length > 0 &&
									(!mutation.symbol || claim.claim.symbol === mutation.symbol),
							),
						)
					)
						unrecordedMutations++;
				}
			}
			const mutations = turns.flatMap((turn) => turn.mutations);
			const claims = turns.flatMap((turn) => turn.claims);
			return {
				scope: turns[0].scope,
				epoch: turns[0].epoch ?? null,
				provider: turns[0].provider,
				model: turns[0].model,
				fingerprint: turns[0].fingerprint,
				turns: turns.length,
				decisions: claims.length,
				citations,
				invalidCitations,
				unknownFreshness,
				unknownScope,
				retrospectiveClaims,
				nonTradingDecisions,
				unrecordedMutations,
				mutationAttempts: mutations.length,
				blockedAttempts: mutations.filter((mutation) => mutation.outcome === "blocked").length,
				unknownOutcomes: mutations.filter(
					(mutation) => mutation.outcome === "unknown" || mutation.outcome === "pending",
				).length,
				interruptedTurns: turns.filter((turn) => turn.status !== "finished").length,
				unrecordedTurns: turns.filter((turn) => turn.claims.length === 0).length,
				incompleteCaptureTurns: turns.filter(
					(turn) =>
						!turn.captureComplete ||
						turn.activeToolsComplete === false ||
						turn.model === "unavailable" ||
						turn.provider === "unavailable",
				).length,
				failedRequests: mutations.filter((mutation) => mutation.outcome === "error").length,
				claimsWithoutEvidence: claims.filter((claim) => claim.claim.observations.length === 0).length,
			};
		});
	return {
		kind: "decision-evaluation",
		version: 1,
		cohorts: reports,
		discipline: {
			status:
				!reports.length ||
				reports.some(
					(report) =>
						!report.decisions ||
						!report.citations ||
						report.unknownFreshness ||
						report.unknownScope ||
						report.interruptedTurns ||
						report.unrecordedTurns ||
						report.incompleteCaptureTurns ||
						report.claimsWithoutEvidence,
				)
					? "insufficient_evidence"
					: reports.some(
								(report) =>
									report.invalidCitations ||
									report.unrecordedMutations ||
									report.retrospectiveClaims ||
									report.blockedAttempts ||
									report.unknownOutcomes,
							)
						? "issues_observed"
						: "no_recorded_discipline_issues",
		},
		runtimeReadiness: "requires_separate_soak_and_recovery_evidence",
		strategy: evaluateStrategy(evidence, now),
		tradingAuthority: "unchanged",
		limitations: [
			"Model rationale is a claim, not proof of reasoning quality.",
			"No observed discipline issues does not establish model truth, profitability or safety.",
			"A tool request completing is not proof of a filled trade.",
			"Local artifacts do not authenticate the underlying observations.",
		],
	};
}
