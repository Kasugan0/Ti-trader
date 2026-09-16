import type { Exchange, MarketInterface, Trade } from "ccxt";
import { describe, expect, it, vi } from "vitest";
import { CcxtExchangeClient } from "./ccxt-client.ts";

function fixture() {
	const client = new CcxtExchangeClient("binance", "USDT", { apiKey: "fixture", secret: "fixture" });
	const exchange = (client as unknown as { exchange: Exchange }).exchange;
	const market = {
		id: "BTCUSDT",
		symbol: "BTC/USDT",
		base: "BTC",
		quote: "USDT",
		spot: true,
		contract: false,
		active: true,
		type: "spot",
		precision: {},
		limits: {},
		info: {},
	} as MarketInterface;
	exchange.setMarkets([market]);
	vi.spyOn(exchange, "loadMarkets").mockResolvedValue(exchange.markets ?? { "BTC/USDT": market });
	const raw = {
		symbol: "BTCUSDT",
		orderId: 11,
		clientOrderId: "client-11",
		status: "FILLED",
		type: "LIMIT",
		side: "SELL",
		origQty: "1",
		executedQty: "1",
		cummulativeQuoteQty: "100",
		time: 1,
	};
	const orderQuery = vi.fn(async () => raw);
	const trades = vi.spyOn(exchange, "fetchOrderTrades").mockResolvedValue([
		{
			id: "trade-11",
			order: "11",
			symbol: "BTC/USDT",
			side: "sell",
			amount: 1,
			cost: 100,
			price: 100,
			fee: { currency: "USDT", cost: 0.1 },
			info: {},
		} as Trade,
	]);
	const placement = vi.spyOn(exchange, "createOrder").mockRejectedValue(new Error("No submission allowed"));
	Object.assign(exchange, { privateGetOrder: orderQuery });
	return { client, exchange, raw, trades, orderQuery, placement };
}

describe("correlated CCXT order fee lookup", () => {
	it("hydrates a completed limit order from one bounded, order-correlated trade page", async () => {
		const f = fixture();
		const order = await f.client.getOrderByClientId("client-11", "BTC/USDT");
		expect(order.feeObservation).toEqual({
			source: "exchange",
			completeness: "complete",
			charges: [{ currency: "USDT", cost: 0.1 }],
		});
		expect(f.trades).toHaveBeenCalledWith("11", "BTC/USDT", undefined, 1000, { paginate: false });
		expect(f.orderQuery).toHaveBeenCalledOnce();
		expect(f.placement).not.toHaveBeenCalled();
	});

	it.each(["absent", "partial", "wrong-order", "wrong-symbol", "duplicate", "missing-id", "unavailable"] as const)(
		"never promotes %s trade fees to a complete observation",
		async (condition) => {
			const f = fixture();
			const trade = (await f.trades("11"))[0];
			f.trades.mockClear();
			if (condition === "absent") f.trades.mockResolvedValue([]);
			if (condition === "partial") f.trades.mockResolvedValue([{ ...trade, amount: 0.5, cost: 50 }]);
			if (condition === "wrong-order") f.trades.mockResolvedValue([{ ...trade, order: "99" }]);
			if (condition === "wrong-symbol") f.trades.mockResolvedValue([{ ...trade, symbol: "ETH/USDT" }]);
			if (condition === "duplicate") f.trades.mockResolvedValue([trade, trade]);
			if (condition === "missing-id") f.trades.mockResolvedValue([{ ...trade, id: undefined }]);
			if (condition === "unavailable") f.trades.mockRejectedValue(new Error("offline"));
			const order = await f.client.getOrder("11", "BTC/USDT");
			expect(order.filled).toBe(1);
			expect(order.feeObservation?.completeness).not.toBe("complete");
			expect(f.trades).toHaveBeenCalledOnce();
			expect(f.placement).not.toHaveBeenCalled();
		},
	);

	it("keeps absent zero-fill fees unknown and skips unsupported lookup capability", async () => {
		const f = fixture();
		Object.assign(f.raw, { status: "CANCELED", executedQty: "0", cummulativeQuoteQty: "0" });
		expect((await f.client.getOrder("11", "BTC/USDT")).feeObservation).toBeUndefined();
		expect(f.trades).not.toHaveBeenCalled();
		Object.assign(f.raw, { status: "FILLED", executedQty: "1", cummulativeQuoteQty: "100" });
		f.exchange.has.fetchOrderTrades = false;
		expect((await f.client.getOrder("11", "BTC/USDT")).feeObservation).toBeUndefined();
		expect(f.trades).not.toHaveBeenCalled();
	});
	it("surfaces a fee lookup failure without logging private provider details", async () => {
		const f = fixture();
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		f.trades.mockRejectedValue(new Error("SECRET-provider-response"));
		try {
			const order = await f.client.getOrder("11", "BTC/USDT");
			expect(order.filled).toBe(1);
			expect(order.feeObservation).toBeUndefined();
			expect(log).toHaveBeenCalledWith(expect.stringContaining("fee completeness remains unknown"));
			expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET");
		} finally {
			log.mockRestore();
		}
	});

	it("does not query fees for a conflicting client identity", async () => {
		const f = fixture();
		await expect(f.client.getOrderByClientId("different", "BTC/USDT")).rejects.toThrow(/clientOrderId/);
		expect(f.trades).not.toHaveBeenCalled();
	});

	it.each([0, -0.1])("preserves an explicit trade fee of %s through real CCXT order parsing", async (cost) => {
		const f = fixture();
		const trade = (await f.trades("11"))[0];
		f.trades.mockClear().mockResolvedValue([{ ...trade, fee: { currency: "USDT", cost } }]);
		const order = await f.client.getOrder("11", "BTC/USDT");
		expect(order.feeObservation).toEqual({
			source: "exchange",
			completeness: "complete",
			charges: [{ currency: "USDT", cost }],
		});
	});

	it("bounds a hanging fee lookup without losing the successful order response", async () => {
		const f = fixture();
		f.trades.mockImplementation(() => new Promise<Trade[]>(() => {}));
		vi.useFakeTimers();
		try {
			const pending = f.client.getOrder("11", "BTC/USDT");
			await vi.advanceTimersByTimeAsync(500);
			const order = await pending;
			expect(order.filled).toBe(1);
			expect(order.feeObservation).toBeUndefined();
			expect(f.trades).toHaveBeenCalledOnce();
			expect(f.placement).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("preserves fees on each native OCO leg without charging the filled leg twice", async () => {
		const f = fixture();
		Object.assign(f.exchange, {
			privateGetOrderList: vi.fn(async () => ({
				orderListId: 7,
				listClientOrderId: "list-client",
				listOrderStatus: "ALL_DONE",
				orders: [
					{ symbol: "BTCUSDT", orderId: 11, clientOrderId: "client-11" },
					{ symbol: "BTCUSDT", orderId: 12, clientOrderId: "client-12" },
				],
			})),
			privateGetOrder: vi.fn(async ({ orderId }: { orderId: string }) =>
				orderId === "11"
					? f.raw
					: {
							...f.raw,
							orderId: 12,
							clientOrderId: "client-12",
							status: "CANCELED",
							executedQty: "0",
							cummulativeQuoteQty: "0",
						},
			),
		});
		const list = await f.client.getOrderListByClientId("list-client");
		expect(list.orders[0].feeObservation?.charges).toEqual([{ currency: "USDT", cost: 0.1 }]);
		expect(list.orders[1].feeObservation).toBeUndefined();
		expect(f.trades).toHaveBeenCalledOnce();
		expect(f.placement).not.toHaveBeenCalled();
	});
});
