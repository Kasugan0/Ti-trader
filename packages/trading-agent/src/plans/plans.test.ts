import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evidenceExtensionHarness, evidenceRuntime } from "../__tests__/evidence-fixture.ts";
import { createPlanExtension } from "./extension.ts";
import { PLAN_MAX_AGE_MS, type PlanContent } from "./model.ts";
import {
	archivePlanExecutions,
	PlanMonitor,
	planIndex,
	preparePlanSubmission,
	reviewPlan,
	validatePlanSubmission,
} from "./runtime.ts";
import { PlanStore } from "./store.ts";

let root: string;
let now: number;
let store: PlanStore;
const content = (): PlanContent => ({
	symbol: "BTC/USDT",
	timeframe: "1h",
	direction: "long",
	thesis: "Breakout with controlled downside",
	entry: [{ fact: "price", operator: "gt", value: 90 }],
	invalidation: [{ fact: "price", operator: "lt", value: 80 }],
	expiresAt: new Date(now + 86_400_000).toISOString(),
	reviewAt: new Date(now + 3_600_000).toISOString(),
	risk: "At most 100 USDT",
	evidence: [{ source: "ticker", observedAt: new Date(now).toISOString(), summary: "Observed 100" }],
});
beforeEach(() => {
	root = mkdtempSync(join(realpathSync(tmpdir()), "ti-plans-"));
	now = Date.now();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(now);
	store = new PlanStore(root, () => now);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	rmSync(root, { recursive: true, force: true });
});

describe("durable plan continuity", () => {
	it("preserves original rationale across revisions and restarts with independent activation CAS", () => {
		const { scope } = evidenceRuntime();
		const draft = store.create(scope, content());
		expect(() => store.activate(draft.id, scope, 0)).toThrow(/conflict/);
		store.activate(draft.id, scope, 1);
		const updated = store.revise(draft.id, scope, 2, { ...content(), thesis: "New evidence" });
		expect(updated.activeVersion).toBe(1);
		store.note(draft.id, scope, "This is model research, not authorization");
		const restored = new PlanStore(root).read(draft.id, scope);
		expect(restored.versions.map((entry) => entry.content.thesis)).toEqual([
			"Breakout with controlled downside",
			"New evidence",
		]);
		expect(restored.notes).toHaveLength(1);
		expect(() => store.read(draft.id, { ...scope, accountId: "other" })).toThrow(/scope/);
		expect(() => store.revise(draft.id, scope, 3, { ...content(), symbol: "ETH/USDT" })).toThrow(/version history/);
		expect(store.read(draft.id, scope).versions).toHaveLength(2);
	});
	it("rejects corruption and symlinks rather than silently discarding saved plans", () => {
		const { scope } = evidenceRuntime();
		store.create(scope, content());
		expect(statSync(store.storage.path).mode & 0o777).toBe(0o600);
		writeFileSync(store.storage.path, "{broken");
		expect(() => store.list(scope)).toThrow();
		rmSync(store.storage.path);
		const target = join(root, "target.json");
		writeFileSync(target, "{}");
		symlinkSync(target, store.storage.path);
		expect(() => store.list(scope)).toThrow(/symbolic/);
		expect(() => store.create(scope, content())).toThrow(/symbolic/);
	});
	it("keeps exports private and rejects overwrite and path traversal", () => {
		const { scope } = evidenceRuntime();
		const plan = store.create(scope, content());
		const path = store.storage.export("private-copy", plan);
		expect(JSON.parse(readFileSync(path, "utf8")).id).toBe(plan.id);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(root, "plans", "exports")).mode & 0o777).toBe(0o700);
		expect(() => store.storage.export("private-copy", plan)).toThrow(/exists/);
		expect(() => store.storage.export("../escape", plan)).toThrow(/identifier/);
	});
	it("invalidates all hidden scopes after Paper reset and requires a newly activated version", () => {
		const { runtime, scope } = evidenceRuntime();
		const draft = store.create(scope, content());
		const hidden = store.create({ ...scope, positionMode: "hedge" }, content());
		store.activate(draft.id, scope, 1);
		store.markPaperReset(scope);
		expect(store.read(hidden.id, hidden.scope).status).toBe("archived");
		expect(() => store.activate(draft.id, scope, 3)).toThrow(/reset/);
		const reference = { id: draft.id, version: 1, intentId: "exit" };
		expect(() =>
			validatePlanSubmission(
				runtime,
				reference,
				{
					intent: { kind: "order", input: { symbol: "BTC/USDT", side: "sell", type: "market", amount: 1 } },
					countTowardsDailyLimit: false,
				},
				store,
				now,
			),
		).toThrow(/reset/);
		store.revise(draft.id, scope, 3, content());
		expect(store.activate(draft.id, scope, 4).activeVersion).toBe(2);
	});
	it("bounds active monitoring and the UTF-8 context without promoting research to authority", () => {
		const { scope } = evidenceRuntime();
		for (let i = 0; i < 21; i++) {
			const plan = store.create(scope, content());
			if (i < 20) store.activate(plan.id, scope, 1);
			else expect(() => store.activate(plan.id, scope, 1)).toThrow(/limit/);
		}
		const index = planIndex(store, scope, now);
		expect(Buffer.byteLength(index)).toBeLessThanOrEqual(4096);
		expect(index).toContain("non-authoritative");
		expect(index).not.toContain(content().thesis);
	});
});

describe("read-only condition monitoring and execution linkage", () => {
	it("reports only complete attributed cash flow and refuses to invent fills from manual reconciliation", async () => {
		const f = evidenceRuntime();
		const draft = store.create(f.scope, content());
		store.activate(draft.id, f.scope, 1);
		await new PlanMonitor(store).tick(f.scope, f.exchange);
		for (const side of ["buy", "sell"] as const) {
			const prepared = await f.engine.prepareOrder(side, { symbol: "BTC/USDT", amount: 1, type: "market" });
			const policy = preparePlanSubmission(
				f.runtime,
				{ id: draft.id, version: 1, intentId: side },
				{
					intent: { kind: "order", input: prepared.input },
					countTowardsDailyLimit: prepared.countTowardsDailyLimit,
				},
				store,
			);
			await f.engine.placeOrder(prepared, policy);
			archivePlanExecutions(f.runtime, store);
		}
		const plan = store.read(draft.id, f.scope);
		expect(reviewPlan(plan)).toMatchObject({
			result: { status: "complete_paper_or_recorded_cash_flow", netQuoteCashFlow: expect.closeTo(-0.2), gaps: [] },
		});
		for (const entry of plan.executions) {
			entry.record.evidence = {
				source: "operator",
				observedAt: new Date(now).toISOString(),
				orders: [],
				reference: "verified-ticket",
			};
			delete entry.fee;
		}
		expect(reviewPlan(plan)).toMatchObject({ result: { status: "insufficient_evidence", netQuoteCashFlow: null } });
	});
	it("deduplicates source reads and condition events, and invalidation never places an order", async () => {
		const f = evidenceRuntime();
		const first = store.create(f.scope, content());
		const second = store.create(f.scope, content());
		store.activate(first.id, f.scope, 1);
		store.activate(second.id, f.scope, 1);
		const monitor = new PlanMonitor(store, () => now);
		expect(await monitor.tick(f.scope, f.exchange)).toHaveLength(2);
		expect(f.exchange.getTicker).toHaveBeenCalledOnce();
		now++;
		expect(await monitor.tick(f.scope, f.exchange)).toEqual([]);
		vi.mocked(f.exchange.getTicker).mockResolvedValue({
			symbol: "BTC/USDT",
			last: 75,
			timestamp: now,
			sourceTimestampKnown: true,
		});
		now++;
		expect(await monitor.tick(f.scope, f.exchange)).toHaveLength(2);
		expect(store.read(first.id, f.scope).observation?.invalidation).toBe("true");
		expect(f.placeOrder).not.toHaveBeenCalled();
		expect(f.exchange.cancelOrder).not.toHaveBeenCalled();
	});
	it("keeps closed 1h candles fresh through the interval while excluding forming/future candles", async () => {
		const f = evidenceRuntime();
		const draft = store.create(f.scope, {
			...content(),
			entry: [{ fact: "closed_price", operator: "gt", value: 90 }],
		});
		store.activate(draft.id, f.scope, 1);
		const closedAt = now - 30 * 60_000;
		vi.mocked(f.exchange.getKlines).mockResolvedValue([
			{ timestamp: closedAt - 3_600_000, open: 100, high: 110, low: 90, close: 100, volume: 1, closed: true },
			{ timestamp: now, open: 1, high: 1, low: 1, close: 1, volume: 1, closed: false },
		]);
		const monitor = new PlanMonitor(store, () => now);
		await monitor.tick(f.scope, f.exchange);
		expect(store.read(draft.id, f.scope).observation?.entry).toBe("true");
		now += 3_600_000;
		await monitor.tick(f.scope, f.exchange);
		expect(store.read(draft.id, f.scope).observation?.entry).toBe("unknown");
	});
	it("makes stale prices unknown and ignores completions from replaced runtimes", async () => {
		const f = evidenceRuntime();
		const plan = store.create(f.scope, content());
		store.activate(plan.id, f.scope, 1);
		const monitor = new PlanMonitor(store, () => now);
		expect(await monitor.tick(f.scope, f.exchange, () => false)).toEqual([]);
		expect(store.read(plan.id, f.scope).observation).toBeUndefined();
		vi.mocked(f.exchange.getTicker).mockResolvedValue({
			symbol: "BTC/USDT",
			last: 100,
			timestamp: now - PLAN_MAX_AGE_MS - 1,
		});
		await monitor.tick(f.scope, f.exchange);
		expect(store.read(plan.id, f.scope).observation?.entry).toBe("unknown");
	});
	it("records immutable references before sending and archives correlated fees without double submission", async () => {
		const f = evidenceRuntime();
		const draft = store.create(f.scope, content());
		store.activate(draft.id, f.scope, 1);
		await new PlanMonitor(store).tick(f.scope, f.exchange);
		const prepared = await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", amount: 1, type: "market" });
		const reference = { id: draft.id, version: 1, intentId: "entry-1" };
		const descriptor = { intent: { kind: "order" as const, input: prepared.input }, countTowardsDailyLimit: true };
		validatePlanSubmission(f.runtime, reference, descriptor, store);
		expect(store.read(draft.id, f.scope).intents).toEqual([]);
		const policy = preparePlanSubmission(f.runtime, reference, descriptor, store);
		const result = await f.engine.placeOrder(prepared, policy);
		expect(f.engine.listExecutions()[0].reference).toEqual({ kind: "trade-plan", id: draft.id, version: 1 });
		expect(archivePlanExecutions(f.runtime, store)).toBe(1);
		expect(archivePlanExecutions(f.runtime, store)).toBe(0);
		expect(store.read(draft.id, f.scope).executions[0]).toMatchObject({
			fee: 0.1,
			record: { id: result.executionId },
		});
		expect(() =>
			preparePlanSubmission(
				f.runtime,
				reference,
				{ ...descriptor, intent: { kind: "order", input: { ...prepared.input, amount: 2 } } },
				store,
			),
		).toThrow(/different/);
		await expect(
			f.engine.placeOrder(
				await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", amount: 1, type: "market" }),
				policy,
			),
		).rejects.toThrow(/already recorded/);
		expect(f.placeOrder).toHaveBeenCalledOnce();
		expect(reviewPlan(store.read(draft.id, f.scope))).toMatchObject({
			result: { status: "insufficient_evidence", netQuoteCashFlow: null },
		});
	});
	it("revalidates operator changes after confirmation and preserves safe reductions after archive", async () => {
		const f = evidenceRuntime();
		const draft = store.create(f.scope, content());
		store.activate(draft.id, f.scope, 1);
		await new PlanMonitor(store).tick(f.scope, f.exchange);
		const prepared = await f.engine.prepareOrder("buy", { symbol: "BTC/USDT", amount: 1, type: "market" });
		const policy = preparePlanSubmission(
			f.runtime,
			{ id: draft.id, version: 1, intentId: "entry" },
			{ intent: { kind: "order", input: prepared.input }, countTowardsDailyLimit: true },
			store,
		);
		await expect(
			f.engine.placeOrder(prepared, {
				...policy,
				confirm: async () => {
					store.archive(draft.id, f.scope, 2);
					return true;
				},
			}),
		).rejects.toThrow(/tracked/);
		expect(f.placeOrder).not.toHaveBeenCalled();
		expect(f.engine.risk.usage().reserved).toBe(0);
		const exit = await f.engine.prepareOrder("sell", { symbol: "BTC/USDT", amount: 1, type: "market" });
		expect(() =>
			validatePlanSubmission(
				f.runtime,
				{ id: draft.id, version: 1, intentId: "exit" },
				{ intent: { kind: "order", input: exit.input }, countTowardsDailyLimit: false },
				store,
			),
		).not.toThrow();
	});
	it("requires operator confirmation for tracking and never registers a model activation tool", async () => {
		const f = evidenceRuntime();
		const h = evidenceExtensionHarness();
		createPlanExtension(() => f.runtime, store)(h.api);
		expect([...h.tools.keys()]).toEqual([
			"list_plans",
			"read_plan",
			"create_plan",
			"revise_plan",
			"append_plan_note",
			"get_plan_review",
		]);
		const draft = store.create(f.scope, content());
		h.confirm.mockResolvedValueOnce(false);
		await h.commands.get("plan")!.handler(`track ${draft.id}`, h.ctx);
		expect(store.read(draft.id, f.scope).status).toBe("draft");
		await h.commands.get("plan")!.handler(`track ${draft.id}`, h.ctx);
		expect(store.read(draft.id, f.scope).status).toBe("tracking");
		expect(await h.emit("before_agent_start")).toMatchObject({
			message: { display: false, content: expect.stringContaining(draft.id) },
		});
		expect(f.placeOrder).not.toHaveBeenCalled();
	});
});
