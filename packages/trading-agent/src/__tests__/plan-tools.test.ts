import { readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Config from "../config.ts";
import type * as OrderReview from "../order-review.ts";
import { evidenceExtensionHarness, evidenceRuntime } from "./evidence-fixture.ts";

const fixture = vi.hoisted(() => ({ root: `${process.cwd()}/.plan-tools-${process.pid}-${Date.now()}` }));
vi.mock("../config.ts", async (original) => ({ ...(await original<typeof Config>()), AGENT_DIR: fixture.root }));
vi.mock("../order-review.ts", async (original) => ({
	...(await original<typeof OrderReview>()),
	showOrderReview: vi.fn(async () => true),
}));

import { evaluateActualExecutions } from "../decisions/evaluation.ts";
import { DecisionStore } from "../decisions/evidence.ts";
import { createDecisionEvidenceExtension } from "../decisions/extension.ts";
import { showOrderReview } from "../order-review.ts";
import type { PlanContent } from "../plans/model.ts";
import { PlanMonitor } from "../plans/runtime.ts";
import { PlanStore } from "../plans/store.ts";
import { SUBMISSION_STATUS_UNKNOWN_MARKER } from "../tools/format.ts";
import { createBuyTool, createCheckOrderTool, createPlaceOcoTool } from "../tools/orders.ts";

beforeEach(() => vi.clearAllMocks());
afterEach(() => rmSync(fixture.root, { recursive: true, force: true }));

async function tracked(mode: "live" | "paper" = "paper") {
	const f = evidenceRuntime(mode);
	const now = Date.now();
	const content: PlanContent = {
		symbol: "BTC/USDT",
		timeframe: "1h",
		direction: "long",
		thesis: "Test research",
		entry: [{ fact: "price", operator: "gt", value: 90 }],
		invalidation: [{ fact: "price", operator: "lt", value: 80 }],
		expiresAt: new Date(now + 86400000).toISOString(),
		reviewAt: new Date(now + 3600000).toISOString(),
		risk: "100 USDT",
		evidence: [{ source: "fixture", observedAt: new Date(now).toISOString(), summary: "Observed price" }],
	};
	const store = new PlanStore(fixture.root);
	const plan = store.create(f.scope, content);
	store.activate(plan.id, f.scope, plan.revision);
	await new PlanMonitor(store).tick(f.scope, f.exchange);
	return { ...f, store, reference: { id: plan.id, version: 1, intentId: "entry" } };
}

describe("native tools preserve plan provenance", () => {
	it("retains actual decision fill and fee evidence after the engine history window", async () => {
		const f = await tracked();
		const h = evidenceExtensionHarness();
		createDecisionEvidenceExtension(() => f.runtime, new DecisionStore(fixture.root), "fixture")(h.api);
		await h.emit("before_agent_start", { systemPrompt: "fixture" });
		await h.tools.get("record_decision")!.execute(
			"reason",
			{
				action: "enter",
				symbol: "BTC/USDT",
				rationale: "Original entry",
				invalidation: "Breakout invalidated",
				horizon: "1h",
				uncertainties: [],
				observations: [],
			},
			undefined,
			undefined,
			h.ctx,
		);
		const input = { symbol: "BTC/USDT", type: "market" as const, amount: 1, plan: f.reference };
		await h.emit("tool_call", { toolName: "buy", toolCallId: "buy", input });
		const result = await createBuyTool(() => f.runtime).execute("buy", input, undefined, undefined, h.ctx);
		await h.emit("tool_result", { toolName: "buy", toolCallId: "buy", input, ...result, isError: false });
		await h.emit("agent_end", { messages: [] });
		const journal = vi.spyOn(f.engine, "listExecutions").mockReturnValue([]);
		try {
			const evaluation = await h.tools
				.get("get_decision_evaluation")!
				.execute("review", { section: "executions" }, undefined, undefined, h.ctx);
			expect(evaluation.details).toMatchObject({
				total: 1,
				items: [{ observedFilledNotional: 100, observedQuoteFee: 0.1, realizedReturn: null }],
			});
			expect(f.placeOrder).toHaveBeenCalledOnce();
			await h.commands.get("decisions")!.handler("export", h.ctx);
			const exported = JSON.parse(readFileSync(h.notify.mock.calls.at(-1)![0] as string, "utf8"));
			expect(
				evaluateActualExecutions(exported.evidence, exported.executionRecords, Date.parse(exported.evaluatedAt))
					.rows[0].observedQuoteFee,
			).toBe(0.1);
		} finally {
			journal.mockRestore();
		}
	});
	it("keeps check_order read-only and archives a successful ordinary order", async () => {
		const f = await tracked();
		const h = evidenceExtensionHarness();
		const params = { symbol: "BTC/USDT", type: "market" as const, amount: 1, plan: f.reference };
		await createCheckOrderTool(() => f.runtime).execute(
			"preflight",
			{ ...params, side: "buy" },
			undefined,
			undefined,
			h.ctx,
		);
		expect(f.store.read(f.reference.id, f.scope).intents).toEqual([]);
		expect(f.engine.listExecutions()).toEqual([]);
		const result = await createBuyTool(() => f.runtime).execute("buy", params, undefined, undefined, h.ctx);
		expect(result.details).toMatchObject({ status: "ok", planEvidence: "archived", plan: f.reference });
		expect(f.store.read(f.reference.id, f.scope).executions).toHaveLength(1);
	});
	it("links OCO exits to the exact plan version", async () => {
		const f = await tracked();
		const h = evidenceExtensionHarness();
		const result = await createPlaceOcoTool(() => f.runtime).execute(
			"oco",
			{
				symbol: "BTC/USDT",
				side: "sell",
				amount: 1,
				stopLossPrice: 80,
				takeProfitPrice: 120,
				plan: { ...f.reference, intentId: "exit-oco" },
			},
			undefined,
			undefined,
			h.ctx,
		);
		expect(result.details).toMatchObject({ status: "ok", planEvidence: "archived" });
		expect(f.store.read(f.reference.id, f.scope).executions[0].record.intent.kind).toBe("oco");
	});
	it("requires plan-linked live confirmation despite unattended direct-order approval", async () => {
		const f = await tracked("live");
		const h = evidenceExtensionHarness();
		const params = { symbol: "BTC/USDT", type: "market" as const, amount: 1, plan: f.reference };
		expect(f.runtime.config.orderApproval).toBe("unattended");
		const check = await createCheckOrderTool(() => f.runtime).execute(
			"check",
			{ ...params, side: "buy" },
			undefined,
			undefined,
			h.ctx,
		);
		expect(check.details).toMatchObject({ requiresLiveConfirmation: true });
		await createBuyTool(() => f.runtime).execute("live", params, undefined, undefined, h.ctx);
		expect(showOrderReview).toHaveBeenCalledOnce();
		expect(f.placeOrder).toHaveBeenCalledOnce();
		const f2 = await tracked("live");
		await expect(
			createBuyTool(() => f2.runtime).execute("headless", { ...params, plan: f2.reference }, undefined, undefined, {
				...h.ctx,
				hasUI: false,
			}),
		).rejects.toThrow(/no UI/);
		expect(f2.placeOrder).not.toHaveBeenCalled();
	});
	it("retries the same plan intentId after confirmation cancel when the ticker moves", async () => {
		const f = await tracked("live");
		const h = evidenceExtensionHarness();
		const params = { symbol: "BTC/USDT", type: "market" as const, amount: 1, plan: f.reference };
		vi.mocked(showOrderReview).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const cancelled = await createBuyTool(() => f.runtime).execute("buy", params, undefined, undefined, h.ctx);
		expect(cancelled.details).toMatchObject({ status: "cancelled" });
		expect(f.placeOrder).not.toHaveBeenCalled();
		vi.mocked(f.exchange.getTicker).mockResolvedValue({
			symbol: "BTC/USDT",
			last: 101,
			bid: 100,
			ask: 102,
			timestamp: Date.now() + 2_000,
			sourceTimestampKnown: true,
		});
		const retried = await createBuyTool(() => f.runtime).execute("buy", params, undefined, undefined, h.ctx);
		expect(retried.details).toMatchObject({ status: "ok", plan: f.reference });
		expect(f.placeOrder).toHaveBeenCalledOnce();
		expect(f.store.read(f.reference.id, f.scope).intents).toHaveLength(1);
	});
	it("blocks a reused plan intentId after an unknown submission even if the ticker moves", async () => {
		const f = await tracked();
		const h = evidenceExtensionHarness();
		const params = { symbol: "BTC/USDT", type: "market" as const, amount: 1, plan: f.reference };
		f.placeOrder.mockRejectedValueOnce(new Error(`timeout ${SUBMISSION_STATUS_UNKNOWN_MARKER}`));
		await expect(createBuyTool(() => f.runtime).execute("buy", params, undefined, undefined, h.ctx)).rejects.toThrow(
			/unknown/,
		);
		vi.mocked(f.exchange.getTicker).mockResolvedValue({
			symbol: "BTC/USDT",
			last: 101,
			bid: 100,
			ask: 102,
			timestamp: Date.now() + 2_000,
			sourceTimestampKnown: true,
		});
		await expect(createBuyTool(() => f.runtime).execute("buy", params, undefined, undefined, h.ctx)).rejects.toThrow(
			/unresolved executions|already recorded/,
		);
		expect(f.placeOrder).toHaveBeenCalledOnce();
	});
	it("reports successful placement with pending evidence rather than retrying after archive failure", async () => {
		const f = await tracked();
		const h = evidenceExtensionHarness();
		const failure = vi.spyOn(PlanStore.prototype, "archiveExecution").mockImplementation(() => {
			throw new Error("disk unavailable");
		});
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const result = await createBuyTool(() => f.runtime).execute(
				"buy",
				{
					symbol: "BTC/USDT",
					type: "market",
					amount: 1,
					plan: f.reference,
				},
				undefined,
				undefined,
				h.ctx,
			);
			expect(result.details).toMatchObject({ status: "ok", planEvidence: "pending" });
			expect(f.placeOrder).toHaveBeenCalledOnce();
			expect(f.engine.listExecutions()[0].archiveAcknowledgedRevision).toBeUndefined();
			expect(h.notify).toHaveBeenCalled();
		} finally {
			failure.mockRestore();
			log.mockRestore();
		}
	});
});
