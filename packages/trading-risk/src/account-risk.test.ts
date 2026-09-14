import { describe, expect, it } from "vitest";
import {
	type AccountRiskFacts,
	type AccountRiskLimits,
	assessAccountRisk,
	assessExecutionPrice,
	validateAccountRiskLimits,
} from "./account-risk.ts";

const now = Date.parse("2026-09-14T00:00:00Z");
const limits: AccountRiskLimits = {
	maxGrossExposure: 500,
	maxNetExposure: 400,
	maxAssetExposure: 300,
	maxLeverage: 2,
	maxMarginUsagePct: 70,
	maxDailyLoss: 100,
	maxDrawdown: 150,
	maxDataAgeMs: 5000,
	maxPriceDeviationPct: 2,
	minDepthRatio: 2,
	minLiquidationDistancePct: 5,
	minProtectionCoveragePct: 95,
	maxStopDistancePct: 10,
	cancelEntriesOnBreach: true,
	reduceOnBreach: true,
};
function facts(): AccountRiskFacts {
	return {
		source: "fixture",
		epoch: "account-v1",
		observedAt: now,
		oldestPriceAt: now,
		equity: 1000,
		netExternalFlows: 1000,
		marginUsed: 0,
		exposures: [],
	};
}

describe("unified account risk", () => {
	it("counts losses during an overnight outage instead of resetting them on restart", () => {
		const before = assessAccountRisk(limits, facts(), undefined, now);
		const tomorrow = now + 86_400_000;
		const after = assessAccountRisk(
			limits,
			{ ...facts(), equity: 850, observedAt: tomorrow, oldestPriceAt: tomorrow },
			before.memory,
			tomorrow,
		);
		expect(after.dailyLoss).toBe(150);
		expect(after.reasons).toContain("lossTrip");
	});
	it("does not invent a nonzero minimum protection or liquidity preference", () => {
		const noMinimum = { ...limits, minProtectionCoveragePct: 0, minDepthRatio: 0, minLiquidationDistancePct: 0 };
		expect(() => validateAccountRiskLimits(noMinimum)).not.toThrow();
	});
	it("requires every numerical threshold and breach policy explicitly", () => {
		expect(() => validateAccountRiskLimits({ ...limits, maxDailyLoss: undefined })).toThrow("maxDailyLoss");
		expect(() => validateAccountRiskLimits({ ...limits, reduceOnBreach: undefined })).toThrow("reduceOnBreach");
		expect(() => validateAccountRiskLimits({ ...limits, maxGrossExposure: Infinity })).toThrow("maxGrossExposure");
	});
	it("adds pending exposure without netting mutually exclusive fills", () => {
		const snapshot = facts();
		snapshot.exposures = [
			{
				asset: "BTC",
				symbol: "BTC/USDT",
				notional: 250,
				pending: false,
				futures: false,
				protectionCoveragePct: 100,
				stopDistancePct: 5,
			},
			{ asset: "BTC", symbol: "BTC/USDT", notional: 200, pending: true, futures: false, protectionCoveragePct: 0 },
			{ asset: "ETH", symbol: "ETH/USDT", notional: -200, pending: true, futures: true, protectionCoveragePct: 0 },
		];
		const result = assessAccountRisk(limits, snapshot, undefined, now);
		expect(result.grossExposure).toBe(650);
		expect(result.netExposure).toBe(450);
		expect(result.reasons).toEqual(
			expect.arrayContaining(["maxGrossExposure", "maxNetExposure", "maxAssetExposure:BTC"]),
		);
	});
	it("does not treat deposits as profit or withdrawals as loss, and latches loss across days", () => {
		const first = assessAccountRisk(limits, facts(), undefined, now);
		const deposit = { ...facts(), equity: 1500, netExternalFlows: 1500 };
		const second = assessAccountRisk(limits, deposit, first.memory, now);
		expect(second.dailyLoss).toBe(0);
		expect(second.memory.peakValue).toBe(0);
		const loss = assessAccountRisk(limits, { ...deposit, equity: 1380 }, second.memory, now);
		expect(loss.dailyLoss).toBe(120);
		expect(loss.memory.lossTrip).toBeDefined();
		const tomorrow = now + 86_400_000;
		const restarted = assessAccountRisk(
			limits,
			{ ...deposit, observedAt: tomorrow, oldestPriceAt: tomorrow },
			JSON.parse(JSON.stringify(loss.memory)),
			tomorrow,
		);
		expect(restarted.reasons).toContain("lossTrip");
		expect(restarted.allowed).toBe(false);
	});
	it("rejects stale, missing, unprotected and margin/liquidation evidence", () => {
		expect(assessAccountRisk(limits, { ...facts(), oldestPriceAt: now - 6000 }, undefined, now).reasons).toContain(
			"stale:oldestPriceAt",
		);
		expect(() => assessAccountRisk(limits, { ...facts(), equity: NaN }, undefined, now)).toThrow("equity");
		const snapshot = {
			...facts(),
			marginUsed: 800,
			exposures: [
				{
					asset: "BTC",
					symbol: "BTC/USDT:USDT",
					notional: 100,
					pending: false,
					futures: true,
					liquidationDistancePct: 2,
					protectionCoveragePct: 0,
				},
			],
		};
		expect(assessAccountRisk(limits, snapshot, undefined, now).reasons).toEqual(
			expect.arrayContaining(["liquidation:BTC/USDT:USDT", "protection:BTC/USDT:USDT", "maxMarginUsagePct"]),
		);
	});
	it("evaluates execution deviation and liquidity with configured thresholds", () => {
		expect(
			assessExecutionPrice(limits, {
				now,
				observedAt: now,
				referencePrice: 100,
				orderPrice: 105,
				availableDepth: 1,
				amount: 1,
			}),
		).toEqual(["maxPriceDeviationPct", "minDepthRatio"]);
	});
});
