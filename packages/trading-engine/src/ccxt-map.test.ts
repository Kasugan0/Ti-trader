import ccxt, { type Order as CcxtOrder, type Ticker as CcxtTicker } from "ccxt";
import { describe, expect, it } from "vitest";
import { isDefiniteSubmissionRejection, isUncertainSubmission, toOrder, toTicker } from "./ccxt-map.ts";

function ccxtOrder(overrides: Record<string, unknown> = {}): CcxtOrder {
	return {
		id: "101970248810",
		symbol: "DOGE/USDT:USDT",
		side: "buy",
		type: "market",
		status: "closed",
		amount: 63,
		filled: 63,
		remaining: 0,
		cost: 0,
		timestamp: 1,
		info: {},
		...overrides,
	} as unknown as CcxtOrder;
}

describe("isUncertainSubmission", () => {
	it("treats transport failures as uncertain even when the message is not a timeout", () => {
		expect(isUncertainSubmission(new Error("socket hang up"))).toBe(true);
		expect(isUncertainSubmission(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
		expect(
			isUncertainSubmission(new ccxt.BadResponse("binance GET https://api.binance.com/api/v3/order 200 <html>")),
		).toBe(true);
		expect(isUncertainSubmission(new ccxt.DDoSProtection("binance 418"))).toBe(true);
		expect(isUncertainSubmission(new ccxt.RateLimitExceeded("Too many requests; -1003"))).toBe(true);
		expect(isUncertainSubmission(new ccxt.RequestTimeout("request timeout"))).toBe(true);
		expect(isUncertainSubmission(new Error("fetch failed"))).toBe(true);
	});

	it("treats explicit business rejections as certain", () => {
		expect(isUncertainSubmission(new ccxt.InsufficientFunds("not enough balance"))).toBe(false);
		expect(isUncertainSubmission(new ccxt.InvalidOrder("Filter failure: LOT_SIZE"))).toBe(false);
		expect(isUncertainSubmission(new ccxt.OrderImmediatelyFillable("Order would immediately trigger"))).toBe(false);
		expect(isUncertainSubmission(new ccxt.AuthenticationError("invalid API-key, IP, or permissions"))).toBe(false);
		expect(isUncertainSubmission(Object.assign(new Error("Account has insufficient balance"), { code: -2010 }))).toBe(
			false,
		);
		expect(isUncertainSubmission(Object.assign(new Error("Filter failure: PRICE_FILTER"), { code: -1013 }))).toBe(
			false,
		);
		expect(isUncertainSubmission(Object.assign(new Error("Order would immediately trigger."), { code: -2021 }))).toBe(
			false,
		);
		expect(isUncertainSubmission(new Error("HTTP 400 insufficient balance"))).toBe(false);
	});
});

describe("isDefiniteSubmissionRejection", () => {
	it("classifies explicit venue business errors as definite rejections", () => {
		expect(isDefiniteSubmissionRejection(new ccxt.PermissionDenied("no trade permission"))).toBe(true);
		expect(isDefiniteSubmissionRejection(new ccxt.BadRequest("malformed request"))).toBe(true);
		expect(isDefiniteSubmissionRejection(new ccxt.ArgumentsRequired("symbol is required"))).toBe(true);
		expect(isDefiniteSubmissionRejection(new ccxt.OperationRejected("order rejected"))).toBe(true);
		expect(isDefiniteSubmissionRejection(new ccxt.NotSupported("not supported"))).toBe(true);
		expect(isDefiniteSubmissionRejection(new Error("HTTP 400 bad request"))).toBe(true);
		expect(isDefiniteSubmissionRejection(Object.assign(new Error("Invalid API-key ID."), { code: -2015 }))).toBe(
			true,
		);
	});

	it("treats duplicates as uncertain so the client-id recovery lookup runs", () => {
		expect(isDefiniteSubmissionRejection(new ccxt.OperationRejected("Duplicate order sent."))).toBe(false);
		expect(isDefiniteSubmissionRejection(new ccxt.DuplicateOrderId("duplicate client order id"))).toBe(false);
		expect(isDefiniteSubmissionRejection(new ccxt.InvalidOrder("Duplicate order sent."))).toBe(false);
	});

	it("treats transport failures and unknown error shapes as uncertain", () => {
		expect(isDefiniteSubmissionRejection(new ccxt.RequestTimeout("request timeout"))).toBe(false);
		expect(isDefiniteSubmissionRejection(new ccxt.BadResponse("binance GET ... 200 <html>"))).toBe(false);
		expect(isDefiniteSubmissionRejection(new Error("socket hang up"))).toBe(false);
		expect(isDefiniteSubmissionRejection("insufficient balance")).toBe(false);
		expect(isDefiniteSubmissionRejection(undefined)).toBe(false);
	});
});

describe("timestamp normalization", () => {
	it("does not treat the Unix epoch as a current market observation", () => {
		const before = Date.now();
		const ticker = toTicker({ symbol: "BTC/USDT", timestamp: 0, last: 100 } as unknown as CcxtTicker);
		const after = Date.now();

		expect(ticker.timestamp).toBeGreaterThanOrEqual(before);
		expect(ticker.timestamp).toBeLessThanOrEqual(after);
		expect(ticker.sourceTimestampKnown).toBe(false);
	});
	it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 8.64e15 + 1])(
		"does not mark the local fallback for %s as a venue timestamp",
		(timestamp) => {
			const raw = new ccxt.binance().parseTicker({ symbol: "BTCUSDT", lastPrice: "100" });
			raw.timestamp = timestamp;
			const before = Date.now();
			const ticker = toTicker(raw);
			expect(ticker.sourceTimestampKnown).toBe(false);
			expect(ticker.timestamp).toBeGreaterThanOrEqual(before);
			expect(ticker.timestamp).toBeLessThanOrEqual(Date.now());
		},
	);
	it("preserves source timestamps through the installed Binance and OKX parsers", () => {
		const timestamp = Date.now();
		for (const raw of [
			new ccxt.binance().parseTicker({ symbol: "BTCUSDT", closeTime: timestamp, lastPrice: "100" }),
			new ccxt.okx().parseTicker({ instId: "BTC-USDT", ts: String(timestamp), last: "100" }),
		])
			expect(toTicker(raw)).toMatchObject({ timestamp, sourceTimestampKnown: true });
	});
});

describe("toOrder fill economics", () => {
	it("maps Binance USDM cumQuote and avgPrice when ccxt leaves cost at 0", () => {
		const order = toOrder(
			ccxtOrder({
				info: { executedQty: "63", cumQuote: "5.18457", avgPrice: "0.082295" },
			}),
			1,
			true,
		);
		expect(order.filled).toBe(63);
		expect(order.cost).toBe(5.18457);
		expect(order.average).toBe(0.082295);
	});

	describe("toOrder actual fee observations", () => {
		it.each([
			{ fee: undefined, expected: undefined },
			{ fee: { rate: 0.001, currency: "USDT" }, expected: undefined },
			{ fee: { cost: 0 }, expected: undefined },
			{ fee: { cost: Number.NaN, currency: "USDT" }, expected: undefined },
			{ fee: { cost: 0, currency: "USDT" }, expected: [{ cost: 0, currency: "USDT" }] },
			{ fee: { cost: -0.1, currency: "USDT" }, expected: [{ cost: -0.1, currency: "USDT" }] },
			{ fee: { cost: 0.01, currency: "BTC" }, expected: [{ cost: 0.01, currency: "BTC" }] },
			{ fee: { cost: 0.02, currency: "BNB" }, expected: [{ cost: 0.02, currency: "BNB" }] },
		])("preserves explicit fees without estimating or converting $fee", ({ fee, expected }) => {
			const order = toOrder(ccxtOrder({ fee, average: 100 }), 10, true);
			expect(order.feeObservation).toEqual(
				expected ? { source: "exchange", completeness: "complete", charges: expected } : undefined,
			);
		});

		it("uses fees rather than its fee alias and preserves multiple original currencies", () => {
			const order = toOrder(
				ccxtOrder({
					fee: { currency: "USDT", cost: 0.1 },
					fees: [
						{ currency: "USDT", cost: 0.1 },
						{ currency: "BNB", cost: 0.01 },
					],
				}),
				1,
				true,
			);
			expect(order.feeObservation).toEqual({
				source: "exchange",
				completeness: "complete",
				charges: [
					{ currency: "USDT", cost: 0.1 },
					{ currency: "BNB", cost: 0.01 },
				],
			});
		});

		it("does not call a partially populated fees array complete", () => {
			const order = toOrder(
				ccxtOrder({
					fees: [{ currency: "USDT", cost: 0.1 }, { currency: "BNB" }],
					fee: { currency: "USDT", cost: 0.1 },
				}),
				1,
				true,
			);
			expect(order.feeObservation).toMatchObject({ completeness: "partial", charges: [{ cost: 0.1 }] });
		});

		it.each(["complete", "partial-quantity", "missing-fee", "wrong-order", "duplicate-trade"] as const)(
			"checks %s trade coverage instead of trusting CCXT's synthesized aggregate",
			(condition) => {
				const trades = [
					{ id: "fill-1", order: "101970248810", amount: 30, fee: { currency: "USDT", cost: 0.03 } },
					{ id: "fill-2", order: "101970248810", amount: 33, fee: { currency: "USDT", cost: 0.033 } },
				];
				if (condition === "partial-quantity") trades.pop();
				if (condition === "missing-fee") Object.assign(trades[1], { fee: undefined });
				if (condition === "wrong-order") trades[1].order = "unrelated";
				if (condition === "duplicate-trade") trades[1].id = trades[0].id;
				const order = toOrder(ccxtOrder({ trades, fee: { currency: "USDT", cost: 0.063 } }), 10, true);
				if (condition === "wrong-order" || condition === "duplicate-trade")
					expect(order.feeObservation).toBeUndefined();
				else
					expect(order.feeObservation).toMatchObject({
						completeness: condition === "complete" ? "complete" : "partial",
						charges: [{ currency: "USDT", cost: condition === "complete" ? 0.063 : 0.03 }],
					});
			},
		);
	});

	it("derives quote cost from filled base and average when cumQuote is missing", () => {
		const order = toOrder(
			ccxtOrder({
				average: 50,
				filled: 2,
				amount: 2,
				info: {},
			}),
			10,
			true,
		);
		expect(order.filled).toBe(20);
		expect(order.cost).toBe(1000);
		expect(order.average).toBe(50);
	});

	it("derives average from cost and filled base", () => {
		const order = toOrder(
			ccxtOrder({
				info: { executedQty: "63", cumQuote: "5.18457" },
			}),
			1,
			true,
		);
		expect(order.cost).toBe(5.18457);
		expect(order.average).toBeCloseTo(5.18457 / 63);
	});

	it("keeps a real zero cost on unfilled orders", () => {
		const order = toOrder(
			ccxtOrder({
				status: "open",
				filled: 0,
				remaining: 63,
				cost: 0,
				info: { executedQty: "0", cumQuote: "0", avgPrice: "0.00000" },
			}),
			1,
			true,
		);
		expect(order.filled).toBe(0);
		expect(order.cost).toBe(0);
		expect(order.average).toBeUndefined();
	});

	it("prefers a positive ccxt cost over raw placeholders", () => {
		const order = toOrder(
			ccxtOrder({
				cost: 12.5,
				average: 0.1,
				info: { cumQuote: "1", avgPrice: "0.01" },
			}),
			1,
			true,
		);
		expect(order.cost).toBe(12.5);
		expect(order.average).toBe(0.1);
	});

	it("maps spot cummulativeQuoteQty when cost is a placeholder zero", () => {
		const order = toOrder(
			ccxtOrder({
				symbol: "BTC/USDT",
				amount: 0.001,
				filled: 0.001,
				remaining: 0,
				info: { origQty: "0.001", executedQty: "0.001", cummulativeQuoteQty: "42.5" },
			}),
			1,
			false,
		);
		expect(order.cost).toBe(42.5);
		expect(order.average).toBe(42500);
	});
});

describe("observed trailing order parameters", () => {
	it.each([
		{ info: { type: "TRAILING_STOP_MARKET", activatePrice: "9020", priceRate: "0.3" }, activation: 9020, rate: 0.3 },
		{
			info: { type: "TRAILING_STOP_MARKET", activationPrice: "9030", callbackRate: "0.5" },
			activation: 9030,
			rate: 0.5,
		},
		{ info: { ordType: "move_order_stop", activePx: "9040", callbackRatio: "0.01" }, activation: 9040, rate: 1 },
	])("normalizes reported activation and percent callback values: $info", ({ info, activation, rate }) => {
		const order = toOrder(ccxtOrder({ info }), 1, true);
		expect(order).toMatchObject({
			type: "trailing_stop_market",
			activationPrice: activation,
			callbackRate: rate,
			trailingPercent: rate,
		});
		expect(order.stopPrice).toBeUndefined();
	});

	it.each([undefined, null, "", 0, "0", Number.NaN, Number.POSITIVE_INFINITY])(
		"does not manufacture actual prices or trailing parameters from %s placeholders",
		(value) => {
			const order = toOrder(
				ccxtOrder({
					price: value,
					triggerPrice: value,
					info: { activatePrice: value, callbackRate: value, trailingPercent: value, trailingDelta: value },
				}),
				1,
				true,
			);
			expect(order.price).toBeUndefined();
			expect(order.stopPrice).toBeUndefined();
			expect(order.activationPrice).toBeUndefined();
			expect(order.callbackRate).toBeUndefined();
			expect(order.trailingPercent).toBeUndefined();
		},
	);
});
