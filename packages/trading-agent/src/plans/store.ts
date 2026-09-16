import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExecutionRecord, ExecutionScope } from "@nikopack/ti-trading-engine";
import { observedExecutionFee, validateTradingSymbol } from "@nikopack/ti-trading-engine";
import { AGENT_DIR } from "../config.ts";
import {
	enqueueMonitoringNotification,
	ensureMonitoringScope,
	type MonitoringStore,
	recordMonitoringObservation,
} from "../monitoring-state.ts";
import { PrivateStore } from "../private-store.ts";
import { canonicalPlanValue, planIntentFingerprint } from "./intent.ts";
import {
	PLAN_LIMITS,
	type PlanAccountObservation,
	type PlanContent,
	type PlanObservation,
	type PlanState,
	planExecutionMatchesProposal,
	sameScope,
	type TradePlan,
	validatePlanContent,
	validatePlanState,
} from "./model.ts";

export function planScopeKey(scope: ExecutionScope): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				scope.accountId,
				scope.mode,
				scope.exchange,
				scope.marketType,
				scope.quoteCurrency,
				scope.positionMode,
			]),
		)
		.digest("hex");
}

export function getPlanStore(agentDir = AGENT_DIR): PlanStore {
	return new PlanStore(agentDir);
}

export function markPaperReset(scope: ExecutionScope, store = getPlanStore()): void {
	store.markPaperReset(scope);
}

export class PlanStore {
	readonly storage: PrivateStore<PlanState>;
	readonly monitoring: MonitoringStore;
	private readonly now: () => number;
	constructor(agentDir = AGENT_DIR, now: () => number = Date.now) {
		this.storage = new PrivateStore(
			join(agentDir, "plans", "state.json"),
			() => ({ version: 1, plans: [], epochs: {} }),
			validatePlanState,
			PLAN_LIMITS.bytes,
		);
		this.monitoring = {
			read: () => this.storage.read().monitoring ?? { version: 1, scopes: [] },
			transact: (operation) =>
				this.storage.transact((state) => {
					state.monitoring ??= { version: 1, scopes: [] };
					return operation(state.monitoring);
				}),
		};
		this.now = now;
	}
	list(scope: ExecutionScope): TradePlan[] {
		return this.storage.read().plans.filter((plan) => sameScope(plan.scope, scope));
	}
	read(id: string, scope: ExecutionScope): TradePlan {
		return this.find(this.storage.read(), id, scope);
	}
	epoch(scope: ExecutionScope): number {
		return this.storage.read().epochs[planScopeKey(scope)] ?? 0;
	}
	claimQueryOffset(scope: ExecutionScope, count: number, pageSize: number): number {
		if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1)
			throw new Error("Invalid bounded query window");
		return this.storage.transact((state) => {
			state.queryOffsets ??= {};
			const key = planScopeKey(scope);
			const offset = (state.queryOffsets[key] ?? 0) % count;
			state.queryOffsets[key] = (offset + pageSize) % count;
			return offset;
		});
	}
	private find(state: PlanState, id: string, scope: ExecutionScope): TradePlan {
		const plan = state.plans.find((candidate) => candidate.id === id && sameScope(candidate.scope, scope));
		if (!plan) throw new Error("Plan not found in the current account scope");
		return plan;
	}
	private event(plan: TradePlan, kind: string, detail: string, version = plan.versions.length): void {
		// Reserve the last slot so a saturated monitor can still be stopped durably.
		const limit = kind === "archived" || kind === "paper-reset" ? PLAN_LIMITS.events : PLAN_LIMITS.events - 1;
		if (plan.events.length >= limit) throw new Error("Plan event capacity reached; export the plan");
		plan.events.push({ id: randomUUID(), at: new Date(this.now()).toISOString(), version, kind, detail });
	}
	private cancelNotifications(state: PlanState, plan: TradePlan, now: number): void {
		if (!state.monitoring) return;
		const scope = ensureMonitoringScope(state.monitoring, plan.scope, now);
		for (const notification of scope.notifications) {
			if (notification.planReference?.id !== plan.id || notification.finishedAt !== undefined) continue;
			notification.status = "cancelled";
			notification.finishedAt = now;
			delete notification.leaseId;
			delete notification.leaseUntil;
		}
	}
	private queueObservation(state: PlanState, plan: TradePlan, now: number): void {
		state.monitoring ??= { version: 1, scopes: [] };
		const scope = ensureMonitoringScope(state.monitoring, plan.scope, now);
		this.cancelNotifications(state, plan, now);
		const lastDelivered = Math.max(
			0,
			...scope.notifications
				.filter((event) => event.planReference?.id === plan.id && event.status === "delivered")
				.map((event) => event.finishedAt ?? 0),
		);
		const eventId = plan.events.at(-1)!.id;
		const id = enqueueMonitoringNotification(
			scope,
			{
				source: "plans",
				customType: "trade-plan-observation",
				planReference: { id: plan.id, version: plan.activeVersion!, eventId },
				content: JSON.stringify({
					condition: plan.observation ?? null,
					totalOrders: plan.accountObservation?.orders.length ?? 0,
					account: plan.accountObservation
						? {
								...plan.accountObservation,
								orders: plan.accountObservation.orders.slice(0, 20),
							}
						: null,
				}),
				notices: [],
				level:
					plan.observation?.invalidation === "true" || plan.accountObservation?.protection === "none"
						? "warning"
						: "info",
				wake: false,
			},
			now,
		);
		scope.notifications.find((event) => event.id === id)!.nextAttemptAt = Math.max(now, lastDelivered + 60_000);
	}
	create(scope: ExecutionScope, content: PlanContent): TradePlan {
		validatePlanContent(content);
		const symbolError = validateTradingSymbol(content.symbol, scope.marketType, scope.quoteCurrency);
		if (symbolError) throw new Error(symbolError);
		return this.storage.transact((state) => {
			if (state.plans.length >= PLAN_LIMITS.plans) throw new Error("Plan capacity reached");
			const plan: TradePlan = {
				id: randomUUID(),
				scope: structuredClone(scope),
				revision: 1,
				status: "draft",
				activeVersion: null,
				versions: [
					{
						version: 1,
						epoch: state.epochs[planScopeKey(scope)] ?? 0,
						at: new Date(this.now()).toISOString(),
						content: structuredClone(content),
					},
				],
				notes: [],
				events: [],
				intents: [],
				executions: [],
			};
			this.event(plan, "created", "Model-authored research; not trading authorization");
			state.plans.push(plan);
			return structuredClone(plan);
		});
	}
	revise(id: string, scope: ExecutionScope, expectedRevision: number, content: PlanContent): TradePlan {
		validatePlanContent(content);
		const symbolError = validateTradingSymbol(content.symbol, scope.marketType, scope.quoteCurrency);
		if (symbolError) throw new Error(symbolError);
		return this.storage.transact((state) => {
			const plan = this.find(state, id, scope);
			if (plan.revision !== expectedRevision) throw new Error("Plan revision conflict; read the latest plan");
			if (plan.versions.length >= PLAN_LIMITS.versions) throw new Error("Plan version capacity reached");
			plan.versions.push({
				version: plan.versions.length + 1,
				epoch: state.epochs[planScopeKey(scope)] ?? 0,
				at: new Date(this.now()).toISOString(),
				content: structuredClone(content),
			});
			plan.revision++;
			this.event(plan, "revised", "New draft; existing approved version is unchanged");
			return structuredClone(plan);
		});
	}
	activate(id: string, scope: ExecutionScope, expectedRevision: number): TradePlan {
		return this.storage.transact((state) => {
			const plan = this.find(state, id, scope);
			if (plan.revision !== expectedRevision) throw new Error("Plan revision conflict; confirm the latest plan");
			const latest = plan.versions.at(-1)!;
			if (latest.epoch !== (state.epochs[planScopeKey(scope)] ?? 0))
				throw new Error("Paper was reset; revise the plan before activating");
			if (Date.parse(latest.content.expiresAt) <= this.now()) throw new Error("Cannot activate an expired plan");
			if (
				plan.status !== "tracking" &&
				state.plans.filter((candidate) => sameScope(candidate.scope, scope) && candidate.status === "tracking")
					.length >= PLAN_LIMITS.active
			)
				throw new Error("Active plan limit reached");
			plan.activeVersion = latest.version;
			plan.status = "tracking";
			delete plan.observation;
			delete plan.accountObservation;
			this.cancelNotifications(state, plan, this.now());
			plan.revision++;
			this.event(plan, "activated", "Operator enabled read-only tracking, not order execution");
			return structuredClone(plan);
		});
	}
	archive(id: string, scope: ExecutionScope, expectedRevision: number): void {
		this.storage.transact((state) => {
			const plan = this.find(state, id, scope);
			if (plan.revision !== expectedRevision) throw new Error("Plan revision conflict");
			if (plan.status === "archived") return;
			plan.status = "archived";
			this.cancelNotifications(state, plan, this.now());
			plan.revision++;
			this.event(plan, "archived", "Orders and positions are unchanged");
		});
	}
	note(id: string, scope: ExecutionScope, text: string, author: "model" | "operator" = "model"): void {
		if (!text.trim() || Buffer.byteLength(text, "utf8") > 4096)
			throw new Error("Plan note must contain 1 to 4096 bytes");
		this.storage.transact((state) => {
			const plan = this.find(state, id, scope);
			if (plan.notes.length >= PLAN_LIMITS.notes) throw new Error("Plan note capacity reached");
			plan.notes.push({ at: new Date(this.now()).toISOString(), author, text });
		});
	}
	observe(id: string, scope: ExecutionScope, observation: PlanObservation, baseline = false): string | undefined {
		return this.storage.transact((state) => {
			const plan = this.find(state, id, scope);
			if (plan.status !== "tracking" || plan.activeVersion !== observation.version) return undefined;
			if (plan.observation && plan.observation.at >= observation.at) return undefined;
			const previous = plan.observation;
			plan.observation = observation;
			const changed =
				!previous ||
				previous.entry !== observation.entry ||
				previous.invalidation !== observation.invalidation ||
				previous.expired !== observation.expired ||
				previous.reviewDue !== observation.reviewDue;
			if (!changed) return undefined;
			this.event(
				plan,
				previous && (baseline || Date.parse(observation.at) - Date.parse(previous.at) > 300_000)
					? "observation-resumed"
					: "condition-change",
				JSON.stringify({
					entry: observation.entry,
					invalidation: observation.invalidation,
					expired: observation.expired,
					reviewDue: observation.reviewDue,
				}),
				observation.version,
			);
			this.queueObservation(state, plan, Date.parse(observation.at));
			return plan.events.at(-1)!.id;
		});
	}
	observeAccount(id: string, scope: ExecutionScope, observation: PlanAccountObservation): string | undefined {
		return this.storage.transact((state) => {
			const plan = this.find(state, id, scope);
			if (plan.status !== "tracking" || plan.activeVersion !== observation.version) return;
			if (plan.accountObservation && plan.accountObservation.at >= observation.at) return;
			const previous = plan.accountObservation;
			plan.accountObservation = structuredClone(observation);
			const changed =
				!previous ||
				previous.status !== observation.status ||
				previous.protection !== observation.protection ||
				JSON.stringify(previous.orders) !== JSON.stringify(observation.orders) ||
				JSON.stringify(previous.positions) !== JSON.stringify(observation.positions);
			if (!changed) return;
			this.event(
				plan,
				"account-observation",
				JSON.stringify({
					status: observation.status,
					protection: observation.protection,
					positions: observation.positions,
					orderCount: observation.orders.length,
					changedOrders: observation.orders
						.filter((order) => !previous?.orders.some((old) => JSON.stringify(old) === JSON.stringify(order)))
						.slice(0, 1),
				}),
				observation.version,
			);
			this.queueObservation(state, plan, Date.parse(observation.at));
			return plan.events.at(-1)!.id;
		});
	}
	recordMonitorHealth(scope: ExecutionScope, observedAt: number | undefined, failed: boolean): void {
		this.monitoring.transact((state) =>
			recordMonitoringObservation(
				ensureMonitoringScope(state, scope, this.now()),
				"plans",
				this.now(),
				observedAt,
				failed,
			),
		);
	}
	markPaperReset(scope: ExecutionScope): void {
		if (scope.mode !== "paper") throw new Error("Plan reset is paper-only");
		this.storage.transact((state) => {
			// ResetAccount resets both Paper ledgers, including plans hidden by market/position-mode changes.
			const scopes = [
				scope,
				...state.plans
					.filter((plan) => plan.scope.mode === "paper" && plan.scope.accountId === scope.accountId)
					.map((plan) => plan.scope),
			];
			for (const key of new Set(scopes.map(planScopeKey))) state.epochs[key] = (state.epochs[key] ?? 0) + 1;
			for (const plan of state.plans.filter(
				(plan) => plan.scope.mode === "paper" && plan.scope.accountId === scope.accountId,
			)) {
				if (plan.status === "archived") continue;
				plan.status = "archived";
				plan.revision++;
				delete plan.observation;
				delete plan.accountObservation;
				this.cancelNotifications(state, plan, this.now());
				this.event(
					plan,
					"paper-reset",
					"Old evidence preserved; a new version and operator activation are required",
				);
			}
		});
	}
	saveIntent(id: string, scope: ExecutionScope, version: number, intentId: string, descriptor: unknown): string {
		if (!/^[A-Za-z0-9_-]{1,80}$/.test(intentId)) throw new Error("Invalid plan intent ID");
		const proposal = canonicalPlanValue(descriptor);
		const fingerprint = planIntentFingerprint(descriptor);
		return this.storage.transact((state) => {
			const plan = this.find(state, id, scope);
			const existing = plan.intents.find((intent) => intent.id === intentId && intent.version === version);
			if (existing) {
				if (existing.fingerprint !== fingerprint)
					throw new Error("Plan intent already binds different order inputs");
				return existing.engineIntentId;
			}
			if (plan.intents.length >= PLAN_LIMITS.events) throw new Error("Plan intent capacity reached");
			const engineIntentId = createHash("sha256")
				.update(`${planScopeKey(scope)}:${id}:${version}:${intentId}`)
				.digest("hex");
			plan.intents.push({
				id: intentId,
				version,
				engineIntentId,
				fingerprint,
				proposal,
				at: new Date(this.now()).toISOString(),
			});
			return engineIntentId;
		});
	}
	archiveExecution(record: ExecutionRecord): void {
		if (record.reference?.kind !== "trade-plan") throw new Error("Execution is not a trade plan reference");
		const reference = record.reference;
		const fee = observedExecutionFee(record);
		this.storage.transact((state) => {
			const plan = this.find(state, reference.id, record.scope);
			if (
				!plan.versions[reference.version - 1] ||
				!plan.intents.some(
					(intent) =>
						intent.version === reference.version &&
						intent.engineIntentId === record.intentId &&
						planExecutionMatchesProposal(intent.proposal, record),
				)
			)
				throw new Error("Execution has no matching saved plan intent");
			const found = plan.executions.find(
				(entry) => entry.record.id === record.id && entry.record.revision === record.revision,
			);
			if (found) {
				const { archiveAcknowledgedRevision: _storedAcknowledgement, ...stored } = found.record;
				const { archiveAcknowledgedRevision: _currentAcknowledgement, ...current } = record;
				if (canonicalPlanValue(stored) !== canonicalPlanValue(current))
					throw new Error("Conflicting execution snapshot at the same revision");
				return;
			}
			if (plan.executions.length >= PLAN_LIMITS.events) throw new Error("Plan execution archive capacity reached");
			plan.executions.push({ record: structuredClone(record), ...(fee === undefined ? {} : { fee }) });
		});
	}
	remove(id: string, scope: ExecutionScope, expectedRevision: number): void {
		this.storage.transact((state) => {
			const plan = this.find(state, id, scope);
			if (plan.revision !== expectedRevision) throw new Error("Plan revision conflict");
			if (plan.status !== "archived" || plan.intents.length)
				throw new Error("Only archived plans without execution intents may be deleted; keep linked evidence");
			this.cancelNotifications(state, plan, this.now());
			state.plans.splice(state.plans.indexOf(plan), 1);
		});
	}
}
