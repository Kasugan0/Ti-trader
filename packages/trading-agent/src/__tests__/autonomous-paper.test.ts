import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AccountRiskLimits,
	controlledRiskClose,
	PaperExchangeClient,
	type RiskStateStore,
	readJsonFile,
	superviseAccountRisk,
	TradingEngine,
	type TradingRiskState,
	writeJsonFileDurable,
} from "@nikopack/ti-trading-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutonomousConfig } from "../autonomous/config.ts";
import { AutonomousRuntime } from "../autonomous/runtime.ts";
import { AutonomousStore } from "../autonomous/state.ts";
import { AutonomousTools } from "../autonomous/tools.ts";
import { createMemoryMonitoringStore } from "../monitoring-state.ts";

const market = vi.hoisted(() => ({ price: 100, fail: false }));
vi.mock("ccxt", () => {
	class PublicMarketFixture {
		precisionMode = 4;
		markets = {
			"BTC/USDT": {
				symbol: "BTC/USDT",
				base: "BTC",
				quote: "USDT",
				spot: true,
				swap: false,
				active: true,
				contract: false,
				precision: { price: 0.01, amount: 0.0001 },
				limits: { amount: { min: 0.0001 }, cost: { min: 1 } },
			},
			"BTC/USDT:USDT": {
				symbol: "BTC/USDT:USDT",
				base: "BTC",
				quote: "USDT",
				settle: "USDT",
				spot: false,
				swap: true,
				active: true,
				contract: true,
				contractSize: 1,
				linear: true,
				inverse: false,
				precision: { price: 0.01, amount: 0.0001 },
				limits: { amount: { min: 0.0001 }, cost: { min: 1 } },
			},
		};
		async loadMarkets() {
			return this.markets;
		}
		async fetchTicker(symbol: string) {
			if (market.fail) throw new Error("fixture disconnected");
			return { symbol, last: market.price, timestamp: Date.now(), info: { markPrice: market.price } };
		}
		async fetchOrderBook() {
			return { timestamp: Date.now(), bids: [[market.price, 100]], asks: [[market.price, 100]] };
		}
		async fetchOHLCV() {
			return [];
		}
		amountToPrecision(_symbol: string, amount: number) {
			return amount.toFixed(4);
		}
		priceToPrecision(_symbol: string, price: number) {
			return price.toFixed(2);
		}
		async close() {}
	}
	return { default: { binance: PublicMarketFixture, TICK_SIZE: 4, DECIMAL_PLACES: 2 } };
});

const limits: AccountRiskLimits = {
	maxGrossExposure: 500,
	maxNetExposure: 500,
	maxAssetExposure: 500,
	maxLeverage: 5,
	maxMarginUsagePct: 80,
	maxDailyLoss: 50,
	maxDrawdown: 100,
	maxDataAgeMs: 10000,
	maxPriceDeviationPct: 5,
	minDepthRatio: 1,
	minLiquidationDistancePct: 5,
	minProtectionCoveragePct: 95,
	maxStopDistancePct: 20,
	cancelEntriesOnBreach: true,
	reduceOnBreach: true,
};
const config: AutonomousConfig = {
	enabled: true,
	mode: "paper",
	exchange: "binance",
	marketType: "spot",
	quoteCurrency: "USDT",
	objective: "Fixture task",
	provider: "fixture",
	model: "fixture",
	pollIntervalMs: 100,
	modelTimeoutMs: 10000,
	serviceTimeoutMs: 1000,
	maxAttempts: 2,
	retryBaseMs: 100,
	retryMaxMs: 1000,
	protectionAttempts: 2,
	services: [],
};
let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "ti-autonomous-paper-"));
	market.price = 100;
	market.fail = false;
});
afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function fixture(futures = false, accountLimits = limits) {
	const client = new PaperExchangeClient(
		"binance",
		"USDT",
		1000,
		0.001,
		directory,
		futures ? "usdm-futures" : "spot",
		5,
	);
	let risk: TradingRiskState = {
		paper: { date: new Date().toISOString().slice(0, 10), usedDailyNotional: 0 },
		live: { date: new Date().toISOString().slice(0, 10), usedDailyNotional: 0 },
	};
	const store: RiskStateStore = {
		load: () => structuredClone(risk),
		save: (value) => {
			risk = structuredClone(value);
		},
		transact: (operation) => {
			const next = structuredClone(risk);
			const result = operation(next);
			risk = next;
			return result;
		},
	};
	const engine = new TradingEngine(
		{
			mode: "paper",
			marketType: futures ? "usdm-futures" : "spot",
			quoteCurrency: "USDT",
			positionMode: "one-way",
			risk: { maxOrderNotional: 500, maxDailyNotional: 1000, allowedSymbols: [], account: accountLimits },
		},
		client,
		store,
		undefined,
		{ durability: "memory", accountId: "isolated-paper" },
	);
	return { engine, client, store };
}

describe("autonomous Paper execution loop without real models or venues", () => {
	it("rejects an opening whose projected liquidation distance violates hard risk", async () => {
		const { engine, client } = fixture(true, { ...limits, minLiquidationDistancePct: 20 });
		const plan = await engine.prepareOrder("buy", { symbol: "BTC/USDT:USDT", type: "market", amount: 1 });
		await expect(
			engine.placeOrder(plan, { intentId: "too-close-to-liquidation", protectionStopPrice: 90 }),
		).rejects.toThrow("liquidation");
		expect(await client.getOrderHistory()).toHaveLength(0);
		expect(engine.risk.usage().reserved).toBe(0);
	});
	it("reports a timed-out RPC intent and blocks new ordinals even after its late completion", async () => {
		const { engine, client } = fixture();
		const state = new AutonomousStore(createMemoryMonitoringStore(), engine.getExecutionScope());
		state.mutate((state) => {
			state.control = "running";
		});
		state.enqueue({ id: "timeout-event", kind: "start", at: Date.now(), message: "One decision" });
		const decision = state.beginDecision()!;
		const tools = new AutonomousTools(engine, state, { ...config, serviceTimeoutMs: 5 });
		const plan = await engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 });
		let release: ((value: typeof plan) => void) | undefined;
		vi.spyOn(engine, "prepareOrder").mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const args = { side: "buy", order: { symbol: "BTC/USDT", type: "market", amount: 1 }, protectionStopPrice: 90 };
		const result = await tools.callWithDeadline(decision.id, 0, "submit_order", args);
		expect(result).toMatchObject({ status: "unknown", intentId: expect.stringMatching(/^[a-f0-9]{64}$/) });
		await expect(tools.callWithDeadline(decision.id, 1, "submit_order", args)).rejects.toThrow("blocks another");
		release?.(plan);
		for (let index = 0; index < 20; index++) await Promise.resolve();
		await expect(tools.callWithDeadline(decision.id, 2, "submit_order", args)).rejects.toThrow("blocks another");
		expect(await client.getOrderHistory()).toHaveLength(0);
	});
	it("accounts for spot fees, PnL and capital without treating a cash deposit as profit", async () => {
		const { client } = fixture();
		await client.placeOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1 });
		const snapshot = await client.getAccountSnapshot();
		expect(snapshot.equity).toBeCloseTo(999.9);
		expect(snapshot.netExternalFlows).toBeCloseTo(1000);
		market.price = 110;
		const appreciated = await client.getAccountSnapshot();
		expect(appreciated.equity).toBeCloseTo(1009.9);
		expect(appreciated.netExternalFlows).toBeCloseTo(1000);
		expect(appreciated.positions[0].unrealizedPnlPct).toBeGreaterThan(0);
		const path = join(directory, "binance-USDT.json");
		const account = readJsonFile(path);
		if (
			!account ||
			typeof account !== "object" ||
			!("balances" in account) ||
			!account.balances ||
			typeof account.balances !== "object" ||
			!("USDT" in account.balances) ||
			typeof account.balances.USDT !== "number"
		)
			throw new Error("Fixture balance missing");
		account.balances.USDT += 500;
		writeJsonFileDurable(path, account);
		const deposit = await client.getAccountSnapshot();
		expect(deposit.equity).toBeCloseTo(1509.9);
		expect(deposit.netExternalFlows).toBeCloseTo(1500);
	});
	it("atomically replaces stops and closes protected holdings without a naked intermediate ledger", async () => {
		const { engine, client } = fixture();
		await engine.placeOrder(await engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 }), {
			intentId: "open",
			protectionStopPrice: 90,
		});
		await superviseAccountRisk(engine, { timeoutMs: 1000, protectionAttempts: 2 });
		const stop = (await client.getOpenOrders())[0];
		await engine.placeOrder(
			await engine.prepareOrder("sell", { symbol: "BTC/USDT", type: "stop_market", amount: 1, stopPrice: 95 }),
			{ intentId: "replace", replacementIds: [stop.id] },
		);
		expect((await client.getOpenOrders()).map((order) => order.stopPrice)).toEqual([95]);
		expect(engine.protectionTargets()[0].stopPrice).toBe(95);
		const snapshot = await client.getAccountSnapshot();
		await controlledRiskClose(engine, snapshot.positions[0], 1000);
		expect(await client.getOpenOrders()).toHaveLength(0);
		expect(await client.getPositions()).toHaveLength(0);
		expect(engine.risk.usage().used).toBe(100);
	});
	it("retains old protection if a replacement violates risk or fails adapter validation", async () => {
		const { engine, client } = fixture();
		await engine.placeOrder(await engine.prepareOrder("buy", { symbol: "BTC/USDT", type: "market", amount: 1 }), {
			intentId: "open",
			protectionStopPrice: 90,
		});
		await superviseAccountRisk(engine, { timeoutMs: 1000, protectionAttempts: 2 });
		const stop = (await client.getOpenOrders())[0];
		await expect(
			engine.placeOrder(
				await engine.prepareOrder("sell", { symbol: "BTC/USDT", type: "stop_market", amount: 1, stopPrice: 50 }),
				{ intentId: "loosen", replacementIds: [stop.id] },
			),
		).rejects.toThrow("Protection");
		await expect(
			client.replaceProtectiveOrders(
				{ symbol: "BTC/USDT", side: "sell", type: "stop_market", amount: 2, stopPrice: 95 },
				[stop.id],
			),
		).rejects.toThrow();
		expect((await client.getOpenOrders()).map((order) => order.id)).toEqual([stop.id]);
		expect((await client.getPositions())[0].amount).toBe(1);
	});
	it("tracks short futures marked equity and fees and atomically closes its protection", async () => {
		const { engine, client } = fixture(true);
		await engine.placeOrder(
			await engine.prepareOrder("sell", { symbol: "BTC/USDT:USDT", type: "market", amount: 1 }),
			{ intentId: "short", protectionStopPrice: 110 },
		);
		await superviseAccountRisk(engine, { timeoutMs: 1000, protectionAttempts: 2 });
		market.price = 95;
		const snapshot = await client.getAccountSnapshot();
		expect(snapshot.netExternalFlows).toBeCloseTo(1000);
		expect(snapshot.equity).toBeCloseTo(1004.9);
		await controlledRiskClose(engine, snapshot.positions[0], 1000);
		expect(await client.getPositions()).toHaveLength(0);
		expect(await client.getOpenOrders()).toHaveLength(0);
	});
	it("retains an unknown leverage mutation until independent observed settings prove it applied", async () => {
		const { engine, client } = fixture(true);
		const apply = client.setLeverage.bind(client);
		vi.spyOn(client, "setLeverage").mockImplementation(async (symbol, leverage) => {
			await apply(symbol, leverage);
			throw new Error("timeout after settings update");
		});
		await expect(engine.setLeverage("BTC/USDT:USDT", 2, "setting-intent")).rejects.toThrow("timeout");
		expect(engine.accountRisk!.state()?.mutation?.id).toBe("setting-intent");
		expect((await engine.accountRisk!.inspect()).assessment.allowed).toBe(false);
		await engine.accountRisk!.reconcileMutation();
		expect(engine.accountRisk!.state()?.mutation).toBeUndefined();
		expect((await client.getRiskSettings("BTC/USDT:USDT")).leverage).toBe(2);
	});
	it("runs a deterministic model through tools, durable actions and the real Paper engine exactly once", async () => {
		const { engine, client } = fixture();
		const state = new AutonomousStore(createMemoryMonitoringStore(), engine.getExecutionScope());
		state.mutate((state) => {
			state.control = "running";
		});
		const tools = new AutonomousTools(engine, state, config);
		let complete: (() => void) | undefined;
		const completed = new Promise<void>((resolve) => {
			complete = resolve;
		});
		const model = {
			run: vi.fn(async (decision: { id: string }) => {
				const args = {
					side: "buy",
					order: { symbol: "BTC/USDT", type: "market", amount: 1 },
					protectionStopPrice: 90,
				};
				const result = await tools.call(decision.id, 0, "submit_order", args);
				expect(result).toMatchObject({ status: "ok" });
				expect(await tools.call(decision.id, 0, "submit_order", args)).toEqual(result);
				complete?.();
				return "Bought once; wait for position event.";
			}),
			stop: async () => {},
		};
		const runtime = new AutonomousRuntime({
			config,
			state,
			model,
			supervise: () => superviseAccountRisk(engine, { timeoutMs: 1000, protectionAttempts: 2 }),
			ticker: (symbol) => engine.getTicker(symbol),
			block: (reason) => engine.accountRisk!.block(reason),
			recover: async () => {
				await engine.recoverExecutions();
			},
		});
		await runtime.initialize();
		runtime.startEvent();
		await runtime.tick();
		await completed;
		await runtime.stop();
		expect(model.run).toHaveBeenCalledTimes(1);
		expect((await client.getOrderHistory()).filter((order) => order.side === "buy")).toHaveLength(1);
		expect(state.read().summaries[0].outcome).toBe("completed");
		await expect(tools.call("unrelated", 0, "submit_order", {})).rejects.toThrow();
	});
});
