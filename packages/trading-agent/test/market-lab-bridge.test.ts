import type { Kline } from "@nikopack/ti-trading-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCandles, setMarketLabCandleProvider } from "../../../extensions/market-lab/index.ts";
import { installMarketLabSessionBridge, uninstallMarketLabSessionBridge } from "../src/market-lab-bridge.ts";

const HOUR_MS = 3_600_000;
const trading = vi.hoisted(() => ({
	mode: "paper" as const,
	config: { quoteCurrency: "USDT" },
	tradingEngine: { id: "okx" },
	marketData: {
		getKlines: vi.fn(
			async (): Promise<Kline[]> =>
				Array.from({ length: 21 }, (_, index) => ({
					timestamp: (index + 1) * 3_600_000,
					closed: index < 20,
					open: 100,
					high: 101,
					low: 99,
					close: 100,
					volume: 10,
				})),
		),
	},
}));

vi.mock("../src/context.ts", () => ({ getTrading: () => trading }));

afterEach(() => {
	uninstallMarketLabSessionBridge();
	setMarketLabCandleProvider(undefined);
	vi.resetAllMocks();
	vi.useRealTimers();
});

describe("market-lab session bridge", () => {
	it("feeds session klines into lab and stamps source", async () => {
		installMarketLabSessionBridge();
		const result = await fetchCandles({ symbol: "BTC/USDT", timeframe: "1h", limit: 20 });
		expect(trading.marketData.getKlines).toHaveBeenCalledWith("BTC/USDT", "1h", 21);
		expect(result.source).toEqual({
			venue: "okx",
			market: "spot",
			kind: "session-klines",
			mode: "paper",
		});
		expect(result.candles).toHaveLength(20);
	});

	it("accepts a futures session symbol", async () => {
		installMarketLabSessionBridge();
		const result = await fetchCandles({ symbol: "BTC/USDT:USDT", timeframe: "1h", limit: 20 });
		expect(trading.marketData.getKlines).toHaveBeenCalledWith("BTC/USDT:USDT", "1h", 21);
		expect(result.source.market).toBe("swap");
	});

	it("does not treat explicitly unclosed candles as a closed history", async () => {
		trading.marketData.getKlines.mockResolvedValue(
			Array.from({ length: 21 }, (_, index) => ({
				timestamp: (index + 1) * HOUR_MS,
				closed: false,
				open: 100,
				high: 101,
				low: 99,
				close: 100,
				volume: 10,
			})),
		);
		installMarketLabSessionBridge();
		await expect(fetchCandles({ symbol: "BTC/USDT", limit: 20 })).rejects.toThrow("Not enough closed candles");
	});

	it("derives missing close flags from the timeframe and keeps the newest requested candles", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(25 * HOUR_MS);
		const candles = Array.from({ length: 25 }, (_, index) => ({
			timestamp: (index + 1) * HOUR_MS,
			open: 100,
			high: 101,
			low: 99,
			close: 100,
			volume: 10,
		}));
		trading.marketData.getKlines.mockImplementation(async () =>
			candles.map((candle) => ({ ...candle, closed: undefined })),
		);
		installMarketLabSessionBridge();
		const result = await fetchCandles({ symbol: "BTC/USDT", timeframe: "1h", limit: 20 });
		expect(result.candles).toHaveLength(20);
		expect(result.candles[0].timestamp).toBe(5 * HOUR_MS);
		expect(result.candles.at(-1)?.timestamp).toBe(24 * HOUR_MS);
	});

	it("excludes future and forming candles even when marked closed", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(21 * HOUR_MS);
		trading.marketData.getKlines.mockResolvedValue(
			Array.from({ length: 23 }, (_, index) => ({
				timestamp: (index + 1) * HOUR_MS,
				closed: true,
				open: 100,
				high: 101,
				low: 99,
				close: 100,
				volume: 10,
			})),
		);
		installMarketLabSessionBridge();
		const result = await fetchCandles({ symbol: "BTC/USDT", timeframe: "1h", limit: 20 });
		expect(result.candles).toHaveLength(20);
		expect(result.candles.at(-1)?.timestamp).toBe(20 * HOUR_MS);
	});

	it("rejects invalid timestamps instead of silently treating them as missing history", async () => {
		trading.marketData.getKlines.mockResolvedValue([
			{ timestamp: Number.NaN, closed: true, open: 100, high: 101, low: 99, close: 100, volume: 10 },
		]);
		installMarketLabSessionBridge();
		await expect(fetchCandles({ symbol: "BTC/USDT", limit: 20 })).rejects.toThrow("invalid timestamp");
	});

	it("does not query the session when cancellation was already requested", async () => {
		installMarketLabSessionBridge();
		await expect(
			fetchCandles({ symbol: "BTC/USDT", limit: 20 }, AbortSignal.abort(new Error("Cancelled"))),
		).rejects.toThrow();
		expect(trading.marketData.getKlines).not.toHaveBeenCalled();
	});

	it("rejects a result collected across a trading-engine replacement", async () => {
		const engine = trading.tradingEngine;
		const candles = await trading.marketData.getKlines();
		trading.marketData.getKlines.mockImplementation(async () => {
			trading.tradingEngine = { id: "binance" };
			return candles;
		});
		installMarketLabSessionBridge();
		try {
			await expect(fetchCandles({ symbol: "BTC/USDT", limit: 20 })).rejects.toThrow("Trading runtime changed");
		} finally {
			trading.tradingEngine = engine;
		}
	});

	it("does not accept a result cancelled during collection", async () => {
		const controller = new AbortController();
		const candles = await trading.marketData.getKlines();
		trading.marketData.getKlines.mockImplementation(async () => {
			controller.abort(new Error("Cancelled during collection"));
			return candles;
		});
		installMarketLabSessionBridge();
		await expect(fetchCandles({ symbol: "BTC/USDT", limit: 20 }, controller.signal)).rejects.toThrow();
	});
});
