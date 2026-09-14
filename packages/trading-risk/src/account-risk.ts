/** All amounts are in the account's configured quote currency. No trading preferences are defaulted. */
export interface AccountRiskLimits {
	maxGrossExposure: number;
	maxNetExposure: number;
	maxAssetExposure: number;
	maxLeverage: number;
	maxMarginUsagePct: number;
	maxDailyLoss: number;
	maxDrawdown: number;
	maxDataAgeMs: number;
	maxPriceDeviationPct: number;
	minDepthRatio: number;
	minLiquidationDistancePct: number;
	minProtectionCoveragePct: number;
	maxStopDistancePct: number;
	cancelEntriesOnBreach: boolean;
	reduceOnBreach: boolean;
}

export interface RiskExposure {
	asset: string;
	symbol: string;
	/** Signed quote exposure; pending buys and sells must NOT offset each other. */
	notional: number;
	pending: boolean;
	liquidationDistancePct?: number;
	protectionCoveragePct: number;
	stopDistancePct?: number;
	futures: boolean;
	/** Proposed post-fill exposure; its liquidation evidence is required before admission. */
	projected?: boolean;
}

export interface AccountRiskFacts {
	source: string;
	epoch: string;
	observedAt: number;
	oldestPriceAt: number;
	equity: number;
	/** Complete cumulative net external capital flows, including initial capital. */
	netExternalFlows: number;
	marginUsed: number;
	exposures: RiskExposure[];
}

export interface AccountRiskMemory {
	epoch: string;
	date: string;
	dailyOpeningValue: number;
	peakValue: number;
	lastObservedAt: number;
	lastValue?: number;
	/** Loss trips are latched separately from transient missing-data blocks and user pauses. */
	lossTrip?: { at: number; reasons: string[] };
}

export interface AccountRiskAssessment {
	allowed: boolean;
	reasons: string[];
	grossExposure: number;
	netExposure: number;
	assetExposure: Record<string, number>;
	leverage: number;
	marginUsagePct: number;
	dailyLoss: number;
	drawdown: number;
	memory: AccountRiskMemory;
}

const numericLimits = [
	"maxGrossExposure",
	"maxNetExposure",
	"maxAssetExposure",
	"maxLeverage",
	"maxMarginUsagePct",
	"maxDailyLoss",
	"maxDrawdown",
	"maxDataAgeMs",
	"maxPriceDeviationPct",
	"minDepthRatio",
	"minLiquidationDistancePct",
	"minProtectionCoveragePct",
	"maxStopDistancePct",
] as const;

export function validateAccountRiskLimits(value: unknown): asserts value is AccountRiskLimits {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("risk.account must explicitly configure account risk limits");
	}
	const limits = value as Record<string, unknown>;
	for (const name of numericLimits) {
		const number = limits[name];
		const minimum = name.startsWith("min");
		if (typeof number !== "number" || !Number.isFinite(number) || (minimum ? number < 0 : number <= 0)) {
			throw new Error(
				`risk.account.${name} must be explicitly configured as a ${minimum ? "nonnegative" : "positive"} finite number`,
			);
		}
	}
	for (const name of [
		"maxMarginUsagePct",
		"minLiquidationDistancePct",
		"minProtectionCoveragePct",
		"maxStopDistancePct",
	]) {
		if (Number(limits[name]) > 100) throw new Error(`risk.account.${name} must not exceed 100`);
	}
	for (const name of ["cancelEntriesOnBreach", "reduceOnBreach"]) {
		if (typeof limits[name] !== "boolean") throw new Error(`risk.account.${name} must be explicitly configured`);
	}
	if (
		Object.keys(limits).some((key) => ![...numericLimits, "cancelEntriesOnBreach", "reduceOnBreach"].includes(key))
	) {
		throw new Error("Unknown risk.account field");
	}
}

export function validateAccountRiskMemory(value: unknown): asserts value is AccountRiskMemory {
	if (!value || typeof value !== "object") throw new Error("Invalid account risk memory");
	const memory = value as Record<string, unknown>;
	if (
		typeof memory.epoch !== "string" ||
		typeof memory.date !== "string" ||
		!/^\d{4}-\d{2}-\d{2}$/.test(memory.date)
	) {
		throw new Error("Invalid account risk epoch/date");
	}
	for (const key of ["dailyOpeningValue", "peakValue", "lastObservedAt"]) {
		if (typeof memory[key] !== "number" || !Number.isFinite(memory[key]))
			throw new Error(`Invalid risk memory ${key}`);
	}
	if (memory.lastValue !== undefined && (typeof memory.lastValue !== "number" || !Number.isFinite(memory.lastValue)))
		throw new Error("Invalid last observed equity");
	if (memory.lossTrip !== undefined) {
		const trip = memory.lossTrip as { at?: unknown; reasons?: unknown };
		if (
			!trip ||
			typeof trip.at !== "number" ||
			!Number.isFinite(trip.at) ||
			!Array.isArray(trip.reasons) ||
			trip.reasons.length === 0 ||
			trip.reasons.some((reason) => typeof reason !== "string")
		)
			throw new Error("Invalid persistent loss trip");
	}
}

/** Pure rules shared by preview, final submission and the independent monitor. */
export function assessAccountRisk(
	limits: AccountRiskLimits,
	facts: AccountRiskFacts,
	previous: AccountRiskMemory | undefined,
	now: number,
): AccountRiskAssessment {
	validateAccountRiskLimits(limits);
	if (previous) validateAccountRiskMemory(previous);
	if (!Number.isFinite(now) || !facts.epoch || !facts.source)
		throw new Error("Account risk identity/time unavailable");
	for (const key of ["equity", "netExternalFlows", "marginUsed", "observedAt", "oldestPriceAt"] as const) {
		if (!Number.isFinite(facts[key])) throw new Error(`Account risk fact unavailable: ${key}`);
	}
	if (facts.marginUsed < 0) throw new Error("Account margin usage cannot be negative");
	const reasons: string[] = [];
	for (const key of ["observedAt", "oldestPriceAt"] as const) {
		if (facts[key] > now || now - facts[key] > limits.maxDataAgeMs) reasons.push(`stale:${key}`);
	}
	if (previous && previous.epoch !== facts.epoch)
		throw new Error("Account epoch changed; operator reconciliation required");
	if (previous && previous.lastObservedAt > facts.observedAt) throw new Error("Account observation moved backwards");
	const normalizedValue = facts.equity - facts.netExternalFlows;
	if (!Number.isFinite(normalizedValue)) throw new Error("Flow-adjusted equity is unavailable");
	const date = new Date(now).toISOString().slice(0, 10);
	const memory: AccountRiskMemory = previous
		? structuredClone(previous)
		: {
				epoch: facts.epoch,
				date,
				dailyOpeningValue: normalizedValue,
				peakValue: normalizedValue,
				lastObservedAt: facts.observedAt,
			};
	const fresh = !reasons.some((reason) => reason.startsWith("stale:"));
	if (memory.date !== date && fresh) {
		memory.date = date;
		// Include unobserved overnight losses rather than resetting at the first
		// post-restart observation (which could already be below the loss limit).
		memory.dailyOpeningValue = memory.lastValue ?? memory.dailyOpeningValue;
	}
	if (fresh) {
		memory.peakValue = Math.max(memory.peakValue, normalizedValue);
		memory.lastObservedAt = facts.observedAt;
		memory.lastValue = normalizedValue;
	}
	const dailyLoss = Math.max(0, memory.dailyOpeningValue - normalizedValue);
	const drawdown = Math.max(0, memory.peakValue - normalizedValue);
	if (dailyLoss >= limits.maxDailyLoss) reasons.push("maxDailyLoss");
	if (drawdown >= limits.maxDrawdown) reasons.push("maxDrawdown");
	if (fresh && reasons.some((reason) => reason === "maxDailyLoss" || reason === "maxDrawdown")) {
		memory.lossTrip ??= {
			at: now,
			reasons: reasons.filter((reason) => reason === "maxDailyLoss" || reason === "maxDrawdown"),
		};
	}
	if (memory.lossTrip) reasons.push("lossTrip");
	let grossExposure = 0;
	let currentNet = 0;
	let pendingBuys = 0;
	let pendingSells = 0;
	const assetExposure: Record<string, number> = {};
	for (const exposure of facts.exposures) {
		if (!exposure.asset || !Number.isFinite(exposure.notional) || !Number.isFinite(exposure.protectionCoveragePct)) {
			throw new Error("Account exposure or protection evidence unavailable");
		}
		const magnitude = Math.abs(exposure.notional);
		grossExposure += magnitude;
		assetExposure[exposure.asset] = (assetExposure[exposure.asset] ?? 0) + magnitude;
		if (exposure.pending) {
			if (exposure.notional > 0) pendingBuys += magnitude;
			else pendingSells += magnitude;
		} else {
			currentNet += exposure.notional;
			if (magnitude > 0 && exposure.protectionCoveragePct < limits.minProtectionCoveragePct) {
				reasons.push(`protection:${exposure.symbol}`);
			}
		}
		if (magnitude > 0 && exposure.futures && (!exposure.pending || exposure.projected)) {
			if (!Number.isFinite(exposure.liquidationDistancePct)) reasons.push(`missing:liquidation:${exposure.symbol}`);
			else if (exposure.liquidationDistancePct! < limits.minLiquidationDistancePct)
				reasons.push(`liquidation:${exposure.symbol}`);
		}
		if (magnitude > 0 && exposure.protectionCoveragePct > 0) {
			if (!Number.isFinite(exposure.stopDistancePct))
				throw new Error(`Stop distance unavailable: ${exposure.symbol}`);
			if (exposure.stopDistancePct! > limits.maxStopDistancePct) reasons.push(`stopDistance:${exposure.symbol}`);
		}
	}
	const netExposure = Math.max(Math.abs(currentNet + pendingBuys), Math.abs(currentNet - pendingSells));
	const leverage = facts.equity > 0 ? grossExposure / facts.equity : Infinity;
	const marginUsagePct = facts.equity > 0 ? (facts.marginUsed / facts.equity) * 100 : Infinity;
	if (facts.equity <= 0) reasons.push("equity");
	if (grossExposure > limits.maxGrossExposure) reasons.push("maxGrossExposure");
	if (netExposure > limits.maxNetExposure) reasons.push("maxNetExposure");
	for (const [asset, exposure] of Object.entries(assetExposure))
		if (exposure > limits.maxAssetExposure) reasons.push(`maxAssetExposure:${asset}`);
	if (leverage > limits.maxLeverage) reasons.push("maxLeverage");
	if (marginUsagePct > limits.maxMarginUsagePct) reasons.push("maxMarginUsagePct");
	return {
		allowed: reasons.length === 0,
		reasons,
		grossExposure,
		netExposure,
		assetExposure,
		leverage,
		marginUsagePct,
		dailyLoss,
		drawdown,
		memory,
	};
}

export function assessProtectionTarget(
	limits: AccountRiskLimits,
	side: "buy" | "sell",
	reference: number,
	stop: number,
): string[] {
	validateAccountRiskLimits(limits);
	if (![reference, stop].every((value) => Number.isFinite(value) && value > 0)) return ["missing:protectionPrice"];
	const distance = ((side === "sell" ? reference - stop : stop - reference) / reference) * 100;
	return distance <= 0 || distance > limits.maxStopDistancePct ? ["maxStopDistancePct"] : [];
}

export function assessLeverageSetting(limits: AccountRiskLimits, leverage: number): string[] {
	validateAccountRiskLimits(limits);
	return !Number.isFinite(leverage) || leverage <= 0 || leverage > limits.maxLeverage ? ["maxLeverage"] : [];
}

export function assessExecutionPrice(
	limits: AccountRiskLimits,
	facts: {
		now: number;
		observedAt: number;
		referencePrice: number;
		orderPrice: number;
		availableDepth: number;
		amount: number;
	},
): string[] {
	validateAccountRiskLimits(limits);
	for (const [name, value] of Object.entries(facts))
		if (!Number.isFinite(value)) throw new Error(`Execution evidence unavailable: ${name}`);
	if (facts.referencePrice <= 0 || facts.orderPrice <= 0 || facts.amount <= 0 || facts.availableDepth < 0) {
		throw new Error("Execution price/size evidence is invalid");
	}
	const reasons: string[] = [];
	if (facts.observedAt > facts.now || facts.now - facts.observedAt > limits.maxDataAgeMs)
		reasons.push("stale:orderBook");
	if (Math.abs(facts.orderPrice / facts.referencePrice - 1) * 100 > limits.maxPriceDeviationPct)
		reasons.push("maxPriceDeviationPct");
	if (facts.availableDepth / facts.amount < limits.minDepthRatio) reasons.push("minDepthRatio");
	return reasons;
}
