import { isFuturesSymbol, timeframeDurationMs } from "@nikopack/ti-trading-engine";
import { getTrading } from "./context.ts";

/** Must match `MARKET_LAB_CANDLE_PROVIDER_KEY` in extensions/market-lab/index.ts. */
const MARKET_LAB_CANDLE_PROVIDER_KEY = Symbol.for("ti.marketLab.candleProvider");

type SessionCandle = {
	timestamp: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
};

/**
 * Point market-lab at this session's read-only klines so indicators match get_klines.
 * Does not expose order or account methods.
 */
export function installMarketLabSessionBridge(): void {
	const holders = globalThis as Record<PropertyKey, unknown>;
	holders[MARKET_LAB_CANDLE_PROVIDER_KEY] = fetchSessionCandles;
}

export function uninstallMarketLabSessionBridge(): void {
	const holders = globalThis as Record<PropertyKey, unknown>;
	delete holders[MARKET_LAB_CANDLE_PROVIDER_KEY];
}

async function fetchSessionCandles(params: {
	symbol: string;
	timeframe: string;
	limit: number;
	signal?: AbortSignal;
}): Promise<{
	candles: SessionCandle[];
	source: { venue: string; market: "spot" | "swap"; kind: "session-klines"; mode: "paper" | "live" };
}> {
	params.signal?.throwIfAborted();
	const duration = timeframeDurationMs(params.timeframe);
	if (duration === undefined || !Number.isFinite(duration) || duration <= 0)
		throw new Error(`Unsupported candle timeframe: ${params.timeframe}`);
	if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 200)
		throw new Error("Candle limit must be an integer between 1 and 200");
	const trading = getTrading();
	const marketData = trading.marketData;
	const engine = trading.tradingEngine;
	const mode = trading.mode;
	const quoteCurrency = trading.config.quoteCurrency;
	const klines = await marketData.getKlines(params.symbol, params.timeframe, params.limit + 1);
	params.signal?.throwIfAborted();
	const current = getTrading();
	if (
		current !== trading ||
		current.marketData !== marketData ||
		current.tradingEngine !== engine ||
		current.mode !== mode ||
		current.config.quoteCurrency !== quoteCurrency
	)
		throw new Error("Trading runtime changed while loading candles; retry with the current market");
	const now = Date.now();
	const selected = klines
		.filter((kline) => {
			if (!Number.isFinite(kline.timestamp) || kline.timestamp <= 0)
				throw new Error("Market data candle had an invalid timestamp");
			return kline.closed !== false && kline.timestamp + duration <= now;
		})
		.slice(-params.limit);
	return {
		candles: selected.map((kline) => ({
			timestamp: kline.timestamp,
			open: kline.open,
			high: kline.high,
			low: kline.low,
			close: kline.close,
			volume: kline.volume,
		})),
		source: {
			venue: engine.id,
			market: isFuturesSymbol(params.symbol, quoteCurrency) ? "swap" : "spot",
			kind: "session-klines",
			mode,
		},
	};
}
