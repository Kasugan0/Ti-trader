import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWorkerSessionCandles } from "../src/autonomous/worker.ts";

const HOUR_MS = 3_600_000;
const config = { exchange: "okx", quoteCurrency: "USDT", mode: "paper" as const };

function kline(index: number, closed?: boolean) {
	return {
		timestamp: (index + 1) * HOUR_MS,
		closed,
		open: 100,
		high: 101,
		low: 99,
		close: 100,
		volume: 10,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("autonomous worker session candles", () => {
	it("requests one extra bar, drops the forming candle, and keeps the closed limit", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(21 * HOUR_MS);
		const query = vi.fn(async (args: Record<string, unknown>) => {
			expect(args).toMatchObject({ operation: "klines", symbol: "BTC/USDT", timeframe: "1h", limit: 21 });
			return { status: "ok", data: Array.from({ length: 21 }, (_, index) => kline(index, index < 20)) };
		});
		const result = await fetchWorkerSessionCandles({ symbol: "BTC/USDT", timeframe: "1h", limit: 20 }, query, config);
		expect(result.candles).toHaveLength(20);
		expect(result.candles.at(-1)?.timestamp).toBe(20 * HOUR_MS);
		expect(result.source).toEqual({
			venue: "okx",
			market: "spot",
			kind: "session-klines",
			mode: "paper",
		});
	});

	it("classifies a futures session symbol with isFuturesSymbol", async () => {
		const query = vi.fn(async () => ({
			status: "ok",
			data: Array.from({ length: 21 }, (_, index) => kline(index, true)),
		}));
		const result = await fetchWorkerSessionCandles(
			{ symbol: "BTC/USDT:USDT", timeframe: "1h", limit: 20 },
			query,
			config,
		);
		expect(result.source.market).toBe("swap");
	});

	it("rejects invalid timestamps instead of dropping them as missing history", async () => {
		const query = vi.fn(async () => ({
			status: "ok",
			data: [{ timestamp: Number.NaN, closed: true, open: 100, high: 101, low: 99, close: 100, volume: 10 }],
		}));
		await expect(
			fetchWorkerSessionCandles({ symbol: "BTC/USDT", timeframe: "1h", limit: 20 }, query, config),
		).rejects.toThrow("invalid timestamp");
	});
});
