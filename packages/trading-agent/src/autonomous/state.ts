import { createHash, randomUUID } from "node:crypto";
import type { AccountSnapshot, RiskSupervisionReport } from "@nikopack/ti-trading-engine";
import { type Condition, type TriggerDefinition, validateTriggerDefinition } from "@nikopack/ti-triggers";
import {
	cancelTriggerNotifications,
	ensureMonitoringScope,
	findMonitoringScope,
	type MonitoringScope,
	type MonitoringStore,
	monitoringScopeKey,
} from "../monitoring-state.ts";
import { parsePositionPnlFactKey } from "../trigger-facts.ts";

export interface AutonomousEvent {
	id: string;
	kind: "start" | "timer" | "condition" | "fill" | "position" | "risk";
	at: number;
	message: string;
	/** Historical audit evidence only; current decisions must query the account again. */
	evidence?: Pick<AccountSnapshot, "source" | "observedAt" | "equity" | "netExternalFlows" | "marginUsed"> & {
		actions: RiskSupervisionReport["actions"];
	};
}
export interface AutonomousAction {
	id: string;
	name: string;
	args: unknown;
	status: "started" | "completed" | "unknown" | "failed";
	result?: unknown;
}
export interface AutonomousDecision {
	id: string;
	event: AutonomousEvent;
	attempts: number;
	nextAttemptAt: number;
	actions: AutonomousAction[];
	blockedByAction?: string;
}
export interface AutonomousState {
	version: 1;
	control: "running" | "paused" | "stopped";
	heartbeat?: number;
	pid?: number;
	events: AutonomousEvent[];
	/** Exact receipts, retained independently of bounded diagnostic history. */
	receipts: Record<string, true>;
	sequence: number;
	decision?: AutonomousDecision;
	triggerIds: string[];
	lastAccountFingerprint?: string;
	lastOrdersFingerprint?: string;
	lastRiskFingerprint?: string;
	summaries: Array<{
		id: string;
		eventId: string;
		at: number;
		text: string;
		outcome: "completed" | "failed";
		evidence?: AutonomousEvent["evidence"];
	}>;
	failures: Array<{ at: number; source: string; reason: string }>;
	unfinishedActions?: Array<AutonomousAction & { decisionId: string }>;
}

function validateRiskEvidence(evidence: NonNullable<AutonomousEvent["evidence"]>): void {
	if (
		!evidence ||
		typeof evidence.source !== "string" ||
		!evidence.source ||
		![evidence.observedAt, evidence.equity, evidence.netExternalFlows, evidence.marginUsed].every(Number.isFinite) ||
		!Array.isArray(evidence.actions) ||
		evidence.actions.some(
			(action) =>
				!action ||
				typeof action.action !== "string" ||
				typeof action.reference !== "string" ||
				!["completed", "unknown", "failed"].includes(action.status) ||
				(action.reason !== undefined && typeof action.reason !== "string"),
		)
	)
		throw new Error("Invalid risk event evidence");
}

export function validateAutonomousState(value: unknown): asserts value is AutonomousState {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid autonomous state");
	const state = value as AutonomousState;
	if (
		state.version !== 1 ||
		!["running", "paused", "stopped"].includes(state.control) ||
		!Number.isSafeInteger(state.sequence) ||
		state.sequence < 0 ||
		!Array.isArray(state.events) ||
		state.events.length > 256 ||
		!Array.isArray(state.triggerIds) ||
		state.triggerIds.some((id) => typeof id !== "string") ||
		new Set(state.triggerIds).size !== state.triggerIds.length ||
		!Array.isArray(state.summaries) ||
		state.summaries.length > 100 ||
		!Array.isArray(state.failures) ||
		state.failures.length > 100 ||
		!state.receipts ||
		typeof state.receipts !== "object" ||
		Array.isArray(state.receipts) ||
		Object.values(state.receipts).some((receipt) => receipt !== true) ||
		Object.keys(state.receipts).length !== state.sequence ||
		(state.heartbeat !== undefined && (!Number.isFinite(state.heartbeat) || state.heartbeat < 0)) ||
		(state.pid !== undefined && (!Number.isSafeInteger(state.pid) || state.pid <= 0))
	)
		throw new Error("Invalid autonomous state fields");
	for (const event of [...state.events, ...(state.decision ? [state.decision.event] : [])]) {
		if (
			!event ||
			typeof event.id !== "string" ||
			!event.id ||
			!["start", "timer", "condition", "fill", "position", "risk"].includes(event.kind) ||
			typeof event.message !== "string" ||
			!Number.isFinite(event.at)
		)
			throw new Error("Invalid autonomous event");
		if (!Object.hasOwn(state.receipts, event.id)) throw new Error("Autonomous event receipt is missing");
		if (event.evidence !== undefined) validateRiskEvidence(event.evidence);
	}
	if (
		new Set(state.events.map((event) => event.id)).size !== state.events.length ||
		state.events.some((event) => event.id === state.decision?.event.id)
	)
		throw new Error("Duplicate pending autonomous event");
	for (const summary of state.summaries) {
		if (
			!summary ||
			typeof summary.id !== "string" ||
			!/^[a-f0-9]{64}$/.test(summary.id) ||
			typeof summary.eventId !== "string" ||
			!Object.hasOwn(state.receipts, summary.eventId) ||
			!Number.isFinite(summary.at) ||
			typeof summary.text !== "string" ||
			!["completed", "failed"].includes(summary.outcome)
		)
			throw new Error("Invalid autonomous decision summary");
		if (summary.evidence !== undefined) validateRiskEvidence(summary.evidence);
	}
	for (const failure of state.failures) {
		if (
			!failure ||
			!Number.isFinite(failure.at) ||
			typeof failure.source !== "string" ||
			typeof failure.reason !== "string"
		)
			throw new Error("Invalid autonomous failure");
	}
	if (state.decision) {
		if (
			typeof state.decision.id !== "string" ||
			!/^[a-f0-9]{64}$/.test(state.decision.id) ||
			!Array.isArray(state.decision.actions) ||
			!Number.isSafeInteger(state.decision.attempts) ||
			state.decision.attempts < 0 ||
			!Number.isFinite(state.decision.nextAttemptAt)
		)
			throw new Error("Invalid autonomous decision");
		if (state.decision.blockedByAction !== undefined && !/^[a-f0-9]{64}$/.test(state.decision.blockedByAction))
			throw new Error("Invalid blocked decision action");
	}
	if (state.unfinishedActions !== undefined && !Array.isArray(state.unfinishedActions))
		throw new Error("Invalid unfinished autonomous actions");
	const actions = [...(state.decision?.actions ?? []), ...(state.unfinishedActions ?? [])];
	if (new Set(actions.map((action) => action.id)).size !== actions.length)
		throw new Error("Duplicate autonomous action");
	for (const action of actions) {
		if (
			!action ||
			!/^[a-f0-9]{64}$/.test(action.id) ||
			typeof action.name !== "string" ||
			!["started", "completed", "unknown", "failed"].includes(action.status)
		)
			throw new Error("Invalid autonomous action");
	}
	for (const action of state.unfinishedActions ?? [])
		if (!/^[a-f0-9]{64}$/.test(action.decisionId)) throw new Error("Invalid unfinished decision identity");
}

export function newAutonomousState(): AutonomousState {
	return {
		version: 1,
		control: "stopped",
		events: [],
		receipts: {},
		sequence: 0,
		triggerIds: [],
		summaries: [],
		failures: [],
	};
}

export function enqueueAutonomousEvent(state: AutonomousState, event: AutonomousEvent): void {
	if (Object.hasOwn(state.receipts, event.id)) return;
	if (state.events.length >= 256) throw new Error("Autonomous event backlog is full");
	Object.defineProperty(state.receipts, event.id, { value: true, enumerable: true, configurable: true });
	state.events.push(event);
	state.sequence++;
}

export class AutonomousStore {
	readonly store: MonitoringStore;
	readonly scope: MonitoringScope;
	private readonly now: () => number;
	constructor(store: MonitoringStore, scope: MonitoringScope, now = Date.now) {
		this.store = store;
		this.scope = scope;
		this.now = now;
		this.mutate(() => {});
	}
	read(): AutonomousState {
		const state = findMonitoringScope(this.store.read(), this.scope)?.autonomous;
		if (!state) throw new Error("Autonomous state missing");
		validateAutonomousState(state);
		return state;
	}
	mutate<T>(operation: (state: AutonomousState) => T): T {
		return this.store.transact((root) => {
			const scope = ensureMonitoringScope(root, this.scope, this.now());
			scope.autonomous ??= newAutonomousState();
			const result = operation(scope.autonomous);
			validateAutonomousState(scope.autonomous);
			return result;
		});
	}
	enqueue(event: AutonomousEvent): void {
		this.mutate((state) => enqueueAutonomousEvent(state, event));
	}
	recordFailure(source: string, reason: string): void {
		this.mutate((state) => {
			state.failures.push({ at: this.now(), source, reason });
			state.failures = state.failures.slice(-100);
		});
	}
	schedule(definition: TriggerDefinition): string {
		validateTriggerDefinition(definition);
		const validateFacts = (condition: Condition): void => {
			if ("fact" in condition) {
				const key = condition.fact.key;
				const symbol = key.startsWith("position_pnl_pct:")
					? parsePositionPnlFactKey(key).symbol
					: key.startsWith("price:")
						? key.slice("price:".length)
						: "";
				if (!/^[A-Z0-9_-]+\/[A-Z0-9_-]+(?::[A-Z0-9_-]+)?$/.test(symbol))
					throw new Error(`Unsupported wake fact: ${key}`);
			}
			if ("conditions" in condition) for (const child of condition.conditions) validateFacts(child);
			if ("condition" in condition) validateFacts(condition.condition);
		};
		validateFacts(definition.when);
		const id = `autonomous-${definition.id}`;
		return this.store.transact((root) => {
			const entry = ensureMonitoringScope(root, this.scope, this.now());
			const state = entry.autonomous;
			if (!state) throw new Error("Autonomous state missing");
			const old = entry.triggers.find((trigger) => trigger.definition.id === id);
			if (old && !state.triggerIds.includes(id)) throw new Error("Cannot modify another owner's wake");
			if (old) cancelTriggerNotifications(entry, [old.revision], this.now());
			entry.triggers = entry.triggers.filter((trigger) => trigger !== old);
			entry.triggers.push({
				definition: {
					...definition,
					id,
					// biome-ignore lint/suspicious/noThenProperty: TriggerDefinition uses this action field.
					then: { kind: "wake_agent", message: definition.then.message },
				},
				revision: randomUUID(),
				state: { status: "active", armed: true },
				updatedAt: this.now(),
			});
			if (!state.triggerIds.includes(id)) state.triggerIds.push(id);
			return id;
		});
	}
	cancelWake(id: string): void {
		this.store.transact((root) => {
			const entry = ensureMonitoringScope(root, this.scope, this.now());
			if (!entry.autonomous?.triggerIds.includes(id))
				throw new Error("Wake is missing or not owned by this model runtime");
			const old = entry.triggers.find((trigger) => trigger.definition.id === id);
			if (old) cancelTriggerNotifications(entry, [old.revision], this.now());
			entry.triggers = entry.triggers.filter((trigger) => trigger !== old);
			entry.autonomous.triggerIds = entry.autonomous.triggerIds.filter((key) => key !== id);
		});
	}
	beginDecision(): AutonomousDecision | undefined {
		return this.mutate((state) => {
			if (state.control !== "running") return undefined;
			if (!state.decision) {
				const event = state.events.shift();
				if (!event) return undefined;
				state.decision = {
					id: createHash("sha256")
						.update(`${monitoringScopeKey(this.scope)}:${event.id}`)
						.digest("hex"),
					event,
					attempts: 0,
					nextAttemptAt: this.now(),
					actions: [],
				};
			}
			if (state.decision.nextAttemptAt > this.now()) return undefined;
			state.decision.attempts++;
			return structuredClone(state.decision);
		});
	}
	finishDecision(id: string, text: string, outcome: "completed" | "failed"): void {
		this.mutate((state) => {
			if (state.decision?.id !== id) throw new Error("Decision identity changed");
			const unfinished = state.decision.actions.filter(
				(action) => action.status === "started" || action.status === "unknown",
			);
			if (unfinished.length) {
				state.unfinishedActions ??= [];
				state.unfinishedActions.push(...unfinished.map((action) => ({ ...action, decisionId: id })));
			}
			state.summaries.push({
				id,
				eventId: state.decision.event.id,
				at: this.now(),
				text,
				outcome,
				...(state.decision.event.evidence ? { evidence: state.decision.event.evidence } : {}),
			});
			state.summaries = state.summaries.slice(-100);
			delete state.decision;
		});
	}
}
