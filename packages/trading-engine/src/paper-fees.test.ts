import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ccxt from "ccxt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TradingEngine } from "./engine.ts";
import { type ExecutionRiskState, observedExecutionFee } from "./execution-journal.ts";
import { parsePaperAccount } from "./paper-account.ts";
import { PaperExchangeClient } from "./paper-client.ts";
import { readJsonFile, writeJsonFileDurable } from "./persist.ts";
import type { OrderFeeObservation } from "./types.ts";

class OfflineMarkets {
	last = 100;
	precisionMode = ccxt.TICK_SIZE;
	markets = Object.fromEntries(
		["BTC/USDT", "BTC/USDT:USDT"].map((symbol) => {
			const futures = symbol.includes(":");
			return [
				symbol,
				{
					symbol,
					base: "BTC",
					quote: "USDT",
					settle: futures ? "USDT" : undefined,
					spot: !futures,
					swap: futures,
					contract: futures,
					linear: futures,
					inverse: false,
					contractSize: 1,
					active: true,
					precision: { price: 0.01, amount: 0.0001 },
					limits: {},
				},
			];
		}),
	);
	async loadMarkets() {
		return this.markets;
	}
	async fetchTicker(symbol: string) {
		return { symbol, last: this.last, timestamp: Date.now() };
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

const directories: string[] = [];
const clients: PaperExchangeClient[] = [];
afterEach(async () => {
	for (const client of clients.splice(0)) await client.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(marketType: "spot" | "usdm-futures" = "spot", feeRate = 0.001) {
	const directory = mkdtempSync(join(tmpdir(), "ti-paper-fees-"));
	directories.push(directory);
	const market = new OfflineMarkets();
	const symbol = marketType === "spot" ? "BTC/USDT" : "BTC/USDT:USDT";
	const path = join(directory, `binance-USDT${marketType === "spot" ? "" : "-futures"}.json`);
	const createClient = (rate = feeRate) => {
		const client = new PaperExchangeClient("binance", "USDT", 10_000, rate, directory, marketType, 5);
		Object.assign(client, { exchange: market, futuresExchange: market });
		clients.push(client);
		return client;
	};
	const client = createClient();
	let state: ExecutionRiskState = {
		paper: { date: new Date().toISOString().slice(0, 10), usedDailyNotional: 0 },
		live: { date: new Date().toISOString().slice(0, 10), usedDailyNotional: 0 },
	};
	let failSettlement = false;
	const store = {
		load: () => structuredClone(state),
		save: (next: ExecutionRiskState) => {
			state = structuredClone(next);
		},
		transact: <T>(mutate: (draft: ExecutionRiskState) => T): T => {
			const draft = structuredClone(state);
			const result = mutate(draft);
			if (failSettlement && draft.executions?.records.some((record) => record.status === "acknowledged")) {
				failSettlement = false;
				throw new Error("Injected execution settlement failure");
			}
			state = draft;
			return result;
		},
	};
	const engine = (adapter = client) =>
		new TradingEngine(
			{
				mode: "paper",
				marketType,
				quoteCurrency: "USDT",
				positionMode: "one-way",
				risk: { maxOrderNotional: 1000, maxDailyNotional: 100_000, allowedSymbols: [] },
			},
			adapter,
			store,
			undefined,
			{ durability: "memory", accountId: "paper-fee-fixture" },
		);
	return {
		client,
		createClient,
		engine,
		market,
		symbol,
		path,
		ledger: () => parsePaperAccount(readJsonFile(path), path),
		failSettlement: () => {
			failSettlement = true;
		},
	};
}

function actualFee(cost: number): OrderFeeObservation {
	return { source: "paper-ledger", completeness: "complete", charges: [{ currency: "USDT", cost }] };
}

describe("paper actual fee evidence", () => {
	it.each(["spot", "usdm-futures"] as const)(
		"retains %s market fees through lookup and restart, regardless of the new configured rate",
		async (marketType) => {
			for (const feeRate of [0, 0.001]) {
				const f = fixture(marketType, feeRate);
				const result = await f.client.placeOrder({
					symbol: f.symbol,
					side: "buy",
					type: "market",
					amount: 1,
					clientOrderId: "entry",
				});
				expect(result.order.feeObservation).toEqual(actualFee(100 * feeRate));
				const ledger = f.ledger();
				expect(ledger.orders[0].feeObservation).toEqual(actualFee(ledger.trades[0].fee));
				expect(ledger.balances.USDT).toBeCloseTo(10_000 - (marketType === "spot" ? 100 : 20) - 100 * feeRate);
				result.order.feeObservation!.charges[0].cost = 999;
				expect((await f.client.getOrderByClientId("entry", f.symbol)).feeObservation).toEqual(
					actualFee(100 * feeRate),
				);
				const restarted = f.createClient(0.02);
				expect((await restarted.getOrder(result.order.id, f.symbol)).feeObservation).toEqual(
					actualFee(100 * feeRate),
				);
				expect((await restarted.getOrderHistory(f.symbol))[0].feeObservation).toEqual(actualFee(100 * feeRate));
			}
		},
	);

	it.each(["spot", "usdm-futures"] as const)(
		"refreshes completed %s limit fees from the canonical ledger order",
		async (marketType) => {
			const f = fixture(marketType);
			const engine = f.engine();
			const place = vi.spyOn(f.client, "placeOrder");
			await engine.placeOrder(
				await engine.prepareOrder("buy", { symbol: f.symbol, type: "limit", price: 90, amount: 1 }),
				{
					intentId: "limit-fee",
					reference: { kind: "trade-plan", id: "plan", version: 1 },
				},
			);
			const before = engine.listExecutions()[0];
			expect(before.evidence?.orders[0].feeObservation).toEqual(actualFee(0));
			expect(observedExecutionFee(before)).toBeUndefined();
			engine.acknowledgeExecutionArchive(before.id, before.revision);
			const usage = engine.risk.usage();
			f.market.last = 80;
			await engine.refreshExecutionEvidence(before.id);
			const after = engine.listExecutions()[0];
			expect(after.evidence?.orders[0]).toMatchObject({
				id: before.evidence!.orders[0].id,
				status: "closed",
				filled: 1,
				cost: 90,
				feeObservation: actualFee(0.09),
			});
			expect(observedExecutionFee(after)).toBe(0.09);
			expect(after.archiveAcknowledgedRevision).toBe(before.revision);
			expect(engine.risk.usage()).toEqual(usage);
			expect(place).toHaveBeenCalledOnce();
			const restarted = f.createClient(0.02);
			expect(
				(await restarted.getOrderByClientId(after.evidence!.orders[0].clientOrderId!, f.symbol)).feeObservation,
			).toEqual(actualFee(0.09));
		},
	);

	it("records the OCO winner fee once and the sibling's known ledger zero", async () => {
		const f = fixture();
		await f.client.placeOrder({ symbol: f.symbol, side: "buy", type: "market", amount: 1 });
		const engine = f.engine();
		const place = vi.spyOn(f.client, "placeOcoOrder");
		await engine.placeOco(
			await engine.prepareOcoOrder({
				symbol: f.symbol,
				side: "sell",
				amount: 1,
				stopLossPrice: 90,
				takeProfitPrice: 110,
			}),
			{ intentId: "oco-fee", reference: { kind: "trade-plan", id: "plan", version: 1 } },
		);
		const before = engine.listExecutions()[0];
		engine.acknowledgeExecutionArchive(before.id, before.revision);
		await engine.refreshExecutionEvidence(before.id);
		expect(engine.listExecutions()[0].revision).toBe(before.revision);
		f.market.last = 120;
		await engine.refreshExecutionEvidence(before.id);
		const after = engine.listExecutions()[0];
		expect(observedExecutionFee(after)).toBe(0.11);
		expect(after.evidence?.orders.find((order) => order.status === "closed")?.feeObservation).toEqual(
			actualFee(0.11),
		);
		expect(after.evidence?.orders.find((order) => order.status === "canceled")?.feeObservation).toEqual(actualFee(0));
		expect(f.ledger().trades.map((trade) => trade.fee)).toEqual([0.1, 0.11]);
		const restarted = f.engine(f.createClient(0.05));
		await restarted.refreshExecutionEvidence(after.id);
		expect(restarted.listExecutions()[0]).toEqual(after);
		expect(place).toHaveBeenCalledOnce();
	});

	it.each(["spot", "usdm-futures"] as const)(
		"recovers %s actual fees after execution settlement fails, without another placement",
		async (marketType) => {
			const f = fixture(marketType);
			const engine = f.engine();
			const place = vi.spyOn(f.client, "placeOrder");
			f.failSettlement();
			await expect(
				engine.placeOrder(await engine.prepareOrder("buy", { symbol: f.symbol, type: "market", amount: 1 })),
			).rejects.toThrow();
			const adapter = f.createClient(0.02);
			const recoveredPlacement = vi.spyOn(adapter, "placeOrder");
			const recovered = f.engine(adapter);
			expect((await recovered.recoverExecutions({ backoffMs: 0 })).reconciled).toBe(1);
			expect(observedExecutionFee(recovered.listExecutions()[0])).toBe(0.1);
			expect(place).toHaveBeenCalledOnce();
			expect(recoveredPlacement).not.toHaveBeenCalled();
		},
	);

	it("recovers legacy fees only from an exactly reconciled ledger trade, not the configured rate", async () => {
		const f = fixture();
		const result = await f.client.placeOrder({ symbol: f.symbol, side: "buy", type: "market", amount: 1 });
		const ledger = f.ledger();
		delete ledger.orders[0].feeObservation;
		writeJsonFileDurable(f.path, ledger);
		expect((await f.createClient(0).getOrder(result.order.id, f.symbol)).feeObservation).toEqual(actualFee(0.1));
	});

	it.each(["missing", "uncorrelated", "partial", "duplicate"] as const)(
		"keeps legacy %s trade fees unknown",
		async (condition) => {
			const f = fixture();
			const result = await f.client.placeOrder({ symbol: f.symbol, side: "buy", type: "market", amount: 1 });
			const ledger = f.ledger();
			delete ledger.orders[0].feeObservation;
			if (condition === "missing") ledger.trades = [];
			if (condition === "uncorrelated") ledger.trades[0].id = "different-order";
			if (condition === "partial") Object.assign(ledger.trades[0], { amount: 0.5, cost: 50 });
			if (condition === "duplicate") ledger.trades.push(structuredClone(ledger.trades[0]));
			writeJsonFileDurable(f.path, ledger);
			expect((await f.createClient(0).getOrder(result.order.id, f.symbol)).feeObservation).toBeUndefined();
		},
	);

	it.each(["spot", "usdm-futures"] as const)(
		"keeps unknown prior %s partial-fill charges partial while retaining full fill economics",
		async (marketType) => {
			for (const knownPrior of [false, true]) {
				const f = fixture(marketType);
				const result = await f.client.placeOrder({
					symbol: f.symbol,
					side: "buy",
					type: "limit",
					price: 90,
					amount: 1,
				});
				const ledger = f.ledger();
				const order = ledger.orders[0];
				Object.assign(order, { filled: 0.4, cost: 36, average: 90 });
				if (knownPrior) order.feeObservation = actualFee(0.036);
				else delete order.feeObservation;
				if (marketType === "spot") {
					ledger.balances.BTC = 0.4;
					ledger.entries.BTC = { amount: 0.4, cost: 36.036 };
				} else {
					order.reservedMargin = 10.854;
					ledger.entries.BTC = {
						amount: 0.4,
						cost: 36,
						lots: [{ amount: 0.4, price: 90, leverage: 5, marginType: "isolated" }],
					};
				}
				writeJsonFileDurable(f.path, ledger);
				f.market.last = 80;
				const filled = await f.client.getOrder(result.order.id, f.symbol);
				expect(filled).toMatchObject({
					status: "closed",
					amount: 1,
					filled: 1,
					remaining: 0,
					cost: 90,
					average: 90,
				});
				expect(filled.feeObservation?.completeness).toBe(knownPrior ? "complete" : "partial");
				expect(filled.feeObservation?.charges[0].cost).toBeCloseTo(knownPrior ? 0.09 : 0.054);
			}
		},
	);
});
