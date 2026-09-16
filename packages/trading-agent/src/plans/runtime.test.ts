import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evidenceExtensionHarness, evidenceRuntime } from "../__tests__/evidence-fixture.ts";
import { createPlanExtension } from "./extension.ts";
import type { PlanContent } from "./model.ts";
import {
	archivePlanExecutions,
	getPlanContext,
	PlanMonitor,
	preparePlanSubmission,
	reviewPlan,
	validatePlanSubmission,
} from "./runtime.ts";
import { PlanStore } from "./store.ts";

let root: string;
let store: PlanStore;
beforeEach(() => {
	root = mkdtempSync(join(realpathSync(tmpdir()), "ti-plan-runtime-"));
	store = new PlanStore(root);
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

async function tracked() {
	const f = evidenceRuntime();
	const now = Date.now();
	const content: PlanContent = {
		symbol: "BTC/USDT",
		timeframe: "1h",
		direction: "long",
		thesis: "Original research, not an execution assertion",
		entry: [{ fact: "price", operator: "gt", value: 90 }],
		invalidation: [{ fact: "price", operator: "lt", value: 80 }],
		expiresAt: new Date(now + 86_400_000).toISOString(),
		reviewAt: new Date(now + 3_600_000).toISOString(),
		risk: "No permission to change account risk",
		proposedSizeNotes: "One unit maximum",
		proposedStopNotes: "Review the proposed 80 stop separately",
		evidence: [
			{
				source: "model research",
				reference: "research-1",
				observedAt: new Date(now).toISOString(),
				summary: "Untrusted research observation",
			},
		],
	};
	const plan = store.create(f.scope, content);
	store.activate(plan.id, f.scope, plan.revision);
	await new PlanMonitor(store).tick(f.scope, f.exchange);
	const prepared = await f.engine.prepareOrder("buy", { symbol: content.symbol, amount: 1, type: "market" });
	const reference = { id: plan.id, version: 1, intentId: "entry" };
	const submission = {
		intent: { kind: "order" as const, input: prepared.input },
		countTowardsDailyLimit: true,
	};
	return { ...f, plan, content, prepared, reference, submission };
}

describe("trusted plan runtime boundaries", () => {
	it("reads scope and Paper generation without querying the account or market", () => {
		const f = evidenceRuntime();
		expect(getPlanContext(f.runtime, store)).toEqual({ scope: f.scope, generation: 0 });
		expect(getPlanContext(f.runtime, new PlanStore(root))).toEqual({ scope: f.scope, generation: 0 });
		store.markPaperReset(f.scope);
		expect(getPlanContext(f.runtime, store)).toEqual({ scope: f.scope, generation: 1 });
		expect(f.exchange.getTicker).not.toHaveBeenCalled();
		expect(f.placeOrder).not.toHaveBeenCalled();
	});

	it("preserves submission identity across object property order and rejects changed order content", async () => {
		const f = await tracked();
		const first = preparePlanSubmission(f.runtime, f.reference, f.submission, store);
		const reordered = {
			countTowardsDailyLimit: true,
			intent: { input: { ...f.prepared.input }, kind: "order" as const },
		};
		expect(preparePlanSubmission(f.runtime, f.reference, reordered, store).intentId).toBe(first.intentId);
		expect(first.intentId.length).toBeLessThanOrEqual(80);
		expect(() =>
			preparePlanSubmission(
				f.runtime,
				f.reference,
				{ ...f.submission, intent: { kind: "order", input: { ...f.prepared.input, amount: 2 } } },
				store,
			),
		).toThrow(/different/);
		expect(store.read(f.plan.id, f.scope).intents).toHaveLength(1);
	});

	it("reuses a plan intentId after the preparation ticker snapshot moves", async () => {
		const f = await tracked();
		const first = preparePlanSubmission(
			f.runtime,
			f.reference,
			{
				...f.submission,
				referencePrice: f.prepared.referencePrice,
				referenceTimestamp: f.prepared.referenceTimestamp,
			},
			store,
		);
		const retried = preparePlanSubmission(
			f.runtime,
			f.reference,
			{
				...f.submission,
				referencePrice: f.prepared.referencePrice + 1,
				referenceTimestamp: f.prepared.referenceTimestamp + 1_000,
			},
			store,
		);
		expect(retried.intentId).toBe(first.intentId);
		const stored = JSON.parse(store.read(f.plan.id, f.scope).intents[0].proposal) as {
			referencePrice: number;
			referenceTimestamp: number;
		};
		expect(stored.referencePrice).toBe(f.prepared.referencePrice);
		expect(stored.referenceTimestamp).toBe(f.prepared.referenceTimestamp);
	});

	it("rejects same-reference evidence with altered original inputs and accepts archive acknowledgement replay", async () => {
		const f = await tracked();
		await f.engine.placeOrder(f.prepared, preparePlanSubmission(f.runtime, f.reference, f.submission, store));
		const record = f.engine.listExecutions()[0];
		const changed = structuredClone(record);
		changed.intent.input.amount = 2;
		expect(() => store.archiveExecution(changed)).toThrow(/matching saved plan intent/);
		expect(store.read(f.plan.id, f.scope).executions).toHaveLength(0);
		expect(archivePlanExecutions(f.runtime, store)).toBe(1);
		expect(() => store.archiveExecution(f.engine.listExecutions()[0])).not.toThrow();
		expect(store.read(f.plan.id, f.scope).executions).toHaveLength(1);
	});

	it("does not promote a legacy fee total without observed fee provenance into a trading result", async () => {
		const f = await tracked();
		await f.engine.placeOrder(f.prepared, preparePlanSubmission(f.runtime, f.reference, f.submission, store));
		const record = structuredClone(f.engine.listExecutions()[0]);
		record.evidence!.fee = 0;
		for (const order of record.evidence!.orders) delete order.feeObservation;
		store.archiveExecution(record);
		const plan = store.read(f.plan.id, f.scope);
		expect(plan.executions[0].fee).toBeUndefined();
		expect(reviewPlan(plan).result.gaps).toContain(`Unknown fees for ${record.id}`);
		expect(reviewPlan(plan).result.netQuoteCashFlow).toBeNull();
		expect(reviewPlan(plan).differences[0].actual[0].fee).toBeNull();
	});

	it("retains observed rebates without turning them into negative-fee corruption", async () => {
		const f = await tracked();
		await f.engine.placeOrder(f.prepared, preparePlanSubmission(f.runtime, f.reference, f.submission, store));
		const record = structuredClone(f.engine.listExecutions()[0]);
		record.evidence!.fee = -0.01;
		for (const order of record.evidence!.orders) {
			order.feeObservation = {
				source: "paper-ledger",
				completeness: "complete",
				charges: [{ currency: "USDT", cost: -0.01 }],
			};
		}
		store.archiveExecution(record);
		expect(new PlanStore(root).read(f.plan.id, f.scope).executions[0].fee).toBe(-0.01);
	});

	it("rejects local plan validation during account maintenance even with cached satisfied conditions", async () => {
		const f = await tracked();
		const status = f.engine.getExecutionStatus();
		vi.spyOn(f.engine, "getExecutionStatus").mockReturnValue({ ...status, staleRuntime: true });
		expect(() => validatePlanSubmission(f.runtime, f.reference, f.submission, store)).toThrow(/runtime changed/);
		expect(f.placeOrder).not.toHaveBeenCalled();
	});

	it("labels startup caches stale in every restored context instead of asserting current conditions", async () => {
		const f = await tracked();
		const h = evidenceExtensionHarness();
		createPlanExtension(() => f.runtime, store)(h.api);
		expect(await h.emit("before_agent_start")).toMatchObject({
			message: { content: expect.stringContaining("observations=unknown/stale") },
		});
		const result = await h.tools.get("read_plan")!.execute("read", { id: f.plan.id }, undefined, undefined, h.ctx);
		expect(result.details).toMatchObject({
			authority: expect.stringContaining("model-authored-research"),
			version: { content: { proposedSizeNotes: f.content.proposedSizeNotes } },
		});
		expect(f.placeOrder).not.toHaveBeenCalled();
	});

	it("records a restart baseline rather than inventing a crossing during even a short downtime", async () => {
		const f = await tracked();
		const next = Date.now() + 1_000;
		vi.mocked(f.exchange.getTicker).mockResolvedValue({
			symbol: "BTC/USDT",
			last: 75,
			timestamp: next,
			sourceTimestampKnown: true,
		});
		await new PlanMonitor(new PlanStore(root), () => next).tick(f.scope, f.exchange);
		const plan = store.read(f.plan.id, f.scope);
		expect(plan.observation?.invalidation).toBe("true");
		expect(plan.events.filter((event) => event.kind === "observation-resumed")).toHaveLength(1);
		expect(f.placeOrder).not.toHaveBeenCalled();
		expect(f.exchange.cancelOrder).not.toHaveBeenCalled();
	});
});
