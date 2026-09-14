import type { Candle, IndicatorPeriods, IndicatorPoint } from "./indicators.ts";
import { DEFAULT_INDICATOR_PERIODS } from "./indicators.ts";

export const STRATEGY_PRESETS = ["ema-cross", "rsi-revert", "macd-hist"] as const;
export type StrategyPreset = (typeof STRATEGY_PRESETS)[number];
export type MarketBias = "bullish" | "bearish" | "neutral" | "insufficient-data";
export type StrategyConfidence = "low" | "medium";
export type StrategyEvent =
	| "cross-up"
	| "cross-down"
	| "above"
	| "below"
	| "equal"
	| "oversold"
	| "overbought"
	| "mid-range"
	| "insufficient-data";

export interface StrategyEvaluation {
	preset: StrategyPreset;
	bias: MarketBias;
	confidence: StrategyConfidence;
	event: StrategyEvent;
	reasons: string[];
	invalidationCandidates: { bullish: number; bearish: number };
	warnings: string[];
}

const ANALYSIS_WARNINGS = [
	"This is analysis only; no order was created.",
	"The last currently forming candle was excluded.",
];

export function isStrategyPreset(value: string): value is StrategyPreset {
	return (STRATEGY_PRESETS as readonly string[]).includes(value);
}

function recentRange(candles: Candle[]): { high: number; low: number } {
	const recent = candles.slice(-20);
	if (recent.length === 0) return { high: Number.NaN, low: Number.NaN };
	return {
		high: Math.max(...recent.map((candle) => candle.high)),
		low: Math.min(...recent.map((candle) => candle.low)),
	};
}

function insufficient(
	preset: StrategyPreset,
	range: { high: number; low: number },
	reason: string,
): StrategyEvaluation {
	return {
		preset,
		bias: "insufficient-data",
		confidence: "low",
		event: "insufficient-data",
		reasons: [reason],
		invalidationCandidates: { bullish: range.low, bearish: range.high },
		warnings: [...ANALYSIS_WARNINGS],
	};
}

function evaluateEmaCross(
	latest: IndicatorPoint,
	previous: IndicatorPoint | undefined,
	periods: IndicatorPeriods,
): Omit<StrategyEvaluation, "preset" | "invalidationCandidates" | "warnings"> {
	const fast = latest.emaFast ?? latest.ema20;
	const slow = latest.emaSlow ?? latest.ema50;
	if (fast === undefined || slow === undefined) {
		return {
			bias: "insufficient-data",
			confidence: "low",
			event: "insufficient-data",
			reasons: [`EMA${periods.emaSlow} is unavailable`],
		};
	}
	const prevFast = previous?.emaFast ?? previous?.ema20;
	const prevSlow = previous?.emaSlow ?? previous?.ema50;
	let event: StrategyEvent;
	let bias: MarketBias;
	if (fast > slow) {
		bias = "bullish";
		event = prevFast !== undefined && prevSlow !== undefined && prevFast <= prevSlow ? "cross-up" : "above";
	} else if (fast < slow) {
		bias = "bearish";
		event = prevFast !== undefined && prevSlow !== undefined && prevFast >= prevSlow ? "cross-down" : "below";
	} else {
		bias = "neutral";
		event = "equal";
	}
	const label = `EMA${periods.emaFast}`;
	const slowLabel = `EMA${periods.emaSlow}`;
	const reasons = [
		event === "cross-up"
			? `${label} crossed above ${slowLabel}`
			: event === "cross-down"
				? `${label} crossed below ${slowLabel}`
				: event === "above"
					? `${label} is above ${slowLabel}`
					: event === "below"
						? `${label} is below ${slowLabel}`
						: `${label} equals ${slowLabel}`,
	];
	return { bias, confidence: event === "cross-up" || event === "cross-down" ? "medium" : "low", event, reasons };
}

function evaluateRsiRevert(
	latest: IndicatorPoint,
	periods: IndicatorPeriods,
): Omit<StrategyEvaluation, "preset" | "invalidationCandidates" | "warnings"> {
	const value = latest.rsi ?? latest.rsi14;
	if (value === undefined) {
		return {
			bias: "insufficient-data",
			confidence: "low",
			event: "insufficient-data",
			reasons: [`RSI${periods.rsi} is unavailable`],
		};
	}
	const label = `RSI${periods.rsi} is ${value.toFixed(2)}`;
	if (value < 30) {
		return {
			bias: "bullish",
			confidence: "medium",
			event: "oversold",
			reasons: [`${label}; oversold mean-reversion bias`],
		};
	}
	if (value > 70) {
		return {
			bias: "bearish",
			confidence: "medium",
			event: "overbought",
			reasons: [`${label}; overbought mean-reversion bias`],
		};
	}
	return { bias: "neutral", confidence: "low", event: "mid-range", reasons: [`${label}; no mean-reversion extreme`] };
}

function evaluateMacdHist(
	latest: IndicatorPoint,
	previous: IndicatorPoint | undefined,
): Omit<StrategyEvaluation, "preset" | "invalidationCandidates" | "warnings"> {
	const hist = latest.macdHistogram;
	if (hist === undefined) {
		return {
			bias: "insufficient-data",
			confidence: "low",
			event: "insufficient-data",
			reasons: ["MACD histogram is unavailable"],
		};
	}
	const prev = previous?.macdHistogram;
	let event: StrategyEvent;
	let bias: MarketBias;
	if (hist > 0) {
		bias = "bullish";
		event = prev !== undefined && prev <= 0 ? "cross-up" : "above";
	} else if (hist < 0) {
		bias = "bearish";
		event = prev !== undefined && prev >= 0 ? "cross-down" : "below";
	} else {
		bias = "neutral";
		event = "equal";
	}
	const reasons = [
		event === "cross-up"
			? "MACD histogram crossed above zero"
			: event === "cross-down"
				? "MACD histogram crossed below zero"
				: event === "above"
					? "MACD histogram is positive"
					: event === "below"
						? "MACD histogram is negative"
						: "MACD histogram is zero",
	];
	return { bias, confidence: event === "cross-up" || event === "cross-down" ? "medium" : "low", event, reasons };
}

export function evaluateStrategy(
	points: IndicatorPoint[],
	candles: Candle[],
	preset: StrategyPreset,
	periods: IndicatorPeriods = DEFAULT_INDICATOR_PERIODS,
): StrategyEvaluation {
	if (!isStrategyPreset(preset)) throw new Error(`Unsupported strategy preset: ${preset}`);
	const range = recentRange(candles);
	if (!Number.isFinite(range.high) || !Number.isFinite(range.low)) {
		return insufficient(preset, range, "Not enough closed candles for analysis");
	}
	const latest = points.at(-1);
	if (!latest) return insufficient(preset, range, "Unable to calculate indicators");
	const previous = points.at(-2);
	const scored =
		preset === "ema-cross"
			? evaluateEmaCross(latest, previous, periods)
			: preset === "rsi-revert"
				? evaluateRsiRevert(latest, periods)
				: evaluateMacdHist(latest, previous);
	return {
		preset,
		...scored,
		invalidationCandidates: { bullish: range.low, bearish: range.high },
		warnings: [...ANALYSIS_WARNINGS],
	};
}

export type RuleSide = "long" | "short";

export interface RuleReplayTrade {
	signalIndex: number;
	index: number;
	timestamp: number;
	side: RuleSide;
	event: StrategyEvent;
	entryIndex: number;
	exitIndex: number;
	entry: number;
	exit: number;
	horizon: number;
	returnPct: number;
}

export interface RuleReplayResult {
	preset: StrategyPreset;
	horizon: number;
	candleCount: number;
	tradeCount: number;
	longs: number;
	shorts: number;
	wins: number;
	losses: number;
	flats: number;
	winRate: number | null;
	avgReturnPct: number | null;
	sumReturnPct: number;
	bestReturnPct: number | null;
	worstReturnPct: number | null;
	trades: RuleReplayTrade[];
	warnings: string[];
}

const MIN_HORIZON = 1;
const MAX_HORIZON = 20;

export function resolveReplayHorizon(horizon?: number): number {
	const value = horizon === undefined ? 5 : horizon;
	if (!Number.isInteger(value) || value < MIN_HORIZON || value > MAX_HORIZON) {
		throw new Error(`Invalid horizon: integer ${MIN_HORIZON}-${MAX_HORIZON} required`);
	}
	return value;
}

/** Maps a current strategy event to the implied side; replay applies preset-specific transition checks. */
export function signalSide(evaluation: StrategyEvaluation): RuleSide | undefined {
	if (evaluation.event === "cross-up" || evaluation.event === "oversold") return "long";
	if (evaluation.event === "cross-down" || evaluation.event === "overbought") return "short";
	return undefined;
}

/**
 * Replay a named preset on closed candles. Not a backtest: no fees, slippage, or fills.
 * Signals are evaluated at a closed candle, entries use the next candle open, and exits use
 * the close `horizon` candles after the signal. Trades are non-overlapping.
 */
export function simulateRule(
	points: IndicatorPoint[],
	candles: Candle[],
	preset: StrategyPreset,
	periods: IndicatorPeriods = DEFAULT_INDICATOR_PERIODS,
	horizonInput?: number,
): RuleReplayResult {
	if (!isStrategyPreset(preset)) throw new Error(`Unsupported strategy preset: ${preset}`);
	const horizon = resolveReplayHorizon(horizonInput);
	if (points.length !== candles.length) throw new Error("Indicator series length mismatch");
	const trades: RuleReplayTrade[] = [];
	let nextSignalIndex = 1;
	const lastSignalIndex = candles.length - horizon - 1;
	for (let index = 1; index <= lastSignalIndex; index++) {
		if (index < nextSignalIndex) continue;
		const evaluation = evaluateStrategy(points.slice(0, index + 1), candles.slice(0, index + 1), preset, periods);
		const previousEvaluation = evaluateStrategy(points.slice(0, index), candles.slice(0, index), preset, periods);
		const side = signalSide(evaluation);
		if (!side) continue;
		if (
			preset === "rsi-revert" &&
			(previousEvaluation.event === "insufficient-data" || previousEvaluation.event === evaluation.event)
		)
			continue;
		const entryIndex = index + 1;
		const exitIndex = index + horizon;
		const entry = candles[entryIndex].open;
		const exit = candles[exitIndex].close;
		if (!(entry > 0) || !Number.isFinite(exit)) continue;
		const returnPct = ((exit - entry) / entry) * (side === "long" ? 100 : -100);
		trades.push({
			signalIndex: index,
			index,
			timestamp: candles[index].timestamp,
			side,
			event: evaluation.event,
			entryIndex,
			exitIndex,
			entry,
			exit,
			horizon,
			returnPct,
		});
		nextSignalIndex = index + horizon;
	}
	const returns = trades.map((trade) => trade.returnPct);
	const tradeCount = trades.length;
	const sumReturnPct = returns.reduce((sum, value) => sum + value, 0);
	const warnings = [
		"Closed-candle rule replay only; not a backtest.",
		"Signals use only candles closed at the signal index; entries use the next candle open.",
		"No fees, slippage, funding, or fills were applied.",
		"ReturnPct fields use percentage points (10 means 10%); sumReturnPct is additive, not compounded.",
		...ANALYSIS_WARNINGS,
	];
	const minimumCandles =
		(preset === "ema-cross"
			? Math.max(periods.emaFast, periods.emaSlow) + 1
			: preset === "rsi-revert"
				? periods.rsi + 2
				: Math.max(periods.macdFast, periods.macdSlow) + periods.macdSignal) + horizon;
	if (candles.length < minimumCandles) {
		warnings.push(
			`Not enough closed candles for a ${preset} replay sample before the ${horizon}-candle exit horizon; at least ${minimumCandles} are recommended.`,
		);
	}
	if (preset === "rsi-revert") {
		warnings.push(
			"RSI replay opens only on transitions into oversold or overbought states; continuous extremes are not reopened until the state resets.",
		);
	}
	if (tradeCount === 0) {
		warnings.push("No replay trades opened; winRate, avgReturnPct, bestReturnPct, and worstReturnPct are null.");
	}
	return {
		preset,
		horizon,
		candleCount: candles.length,
		tradeCount,
		longs: trades.filter((trade) => trade.side === "long").length,
		shorts: trades.filter((trade) => trade.side === "short").length,
		wins: returns.filter((value) => value > 0).length,
		losses: returns.filter((value) => value < 0).length,
		flats: returns.filter((value) => value === 0).length,
		winRate: tradeCount === 0 ? null : returns.filter((value) => value > 0).length / tradeCount,
		avgReturnPct: tradeCount === 0 ? null : sumReturnPct / tradeCount,
		sumReturnPct,
		bestReturnPct: tradeCount === 0 ? null : Math.max(...returns),
		worstReturnPct: tradeCount === 0 ? null : Math.min(...returns),
		trades,
		warnings,
	};
}
