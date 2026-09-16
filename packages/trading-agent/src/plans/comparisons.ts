import { observedExecutionFee } from "@nikopack/ti-trading-engine";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { TradePlan } from "./model.ts";

const proposalSchema = Type.Object({
	intent: Type.Object({ input: Type.Record(Type.String(), Type.Unknown()) }),
	referencePrice: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	referenceTimestamp: Type.Optional(Type.Number({ minimum: 0 })),
});

export function comparePlanExecutions(plan: TradePlan, executions: TradePlan["executions"]) {
	return plan.intents.map((intent) => {
		const proposal: unknown = JSON.parse(intent.proposal);
		const saved = Check(proposalSchema, proposal) ? proposal : undefined;
		const input = saved?.intent.input;
		const referencePrice =
			saved?.referenceTimestamp &&
			saved.referenceTimestamp <= Date.parse(intent.at) &&
			Date.parse(intent.at) - saved.referenceTimestamp <= 300_000
				? saved.referencePrice
				: undefined;
		const records = executions.filter((entry) => entry.record.intentId === intent.engineIntentId);
		const gaps: string[] = [];
		if (!input) gaps.push("Structured original proposal unavailable");
		if (referencePrice === undefined)
			gaps.push("Fresh preparation price snapshot unavailable; price deviation is unknown");
		if (!records.length) gaps.push("No durable execution; proposal is not proof of submission");
		const actual = records.map(({ record }) => {
			if (!record.evidence?.orders.length) gaps.push(`No fill-level evidence for ${record.id}`);
			return {
				executionId: record.id,
				status: record.status,
				source: record.evidence?.source ?? null,
				fee: observedExecutionFee(record) ?? null,
				orders: (record.evidence?.orders ?? []).map((order) => {
					const differences: { field: string; proposed: unknown; actual: unknown }[] = [];
					for (const field of [
						"symbol",
						"side",
						"amount",
						"reduceOnly",
						"positionSide",
						"closePosition",
					] as const) {
						if (input?.[field] !== undefined) {
							if (order[field] === undefined) gaps.push(`Actual ${field} unavailable for ${order.id}`);
							else if (input[field] !== order[field])
								differences.push({ field, proposed: input[field], actual: order[field] });
						}
					}
					if (record.intent.kind === "order") {
						if (input?.type !== undefined) {
							if (order.type === undefined) gaps.push(`Actual type unavailable for ${order.id}`);
							else if (input.type !== order.type)
								differences.push({ field: "type", proposed: input.type, actual: order.type });
						}
						for (const field of ["price", "stopPrice"] as const)
							if (input?.[field] !== undefined) {
								if (order[field] === undefined) gaps.push(`Actual ${field} unavailable for ${order.id}`);
								else if (input[field] !== order[field])
									differences.push({ field, proposed: input[field], actual: order[field] });
							}
					} else if (input) {
						let expectedPrice: unknown;
						let expectedStop: unknown;
						if (order.type === "stop" || order.type === "stop_market") {
							expectedStop = input.stopLossPrice;
							expectedPrice = input.stopLossLimitPrice;
						} else if (order.type === "limit") {
							expectedPrice = input.takeProfitPrice;
						} else if (order.type === "take_profit" || order.type === "take_profit_market") {
							expectedStop = input.takeProfitPrice;
							expectedPrice = input.takeProfitLimitPrice;
						} else gaps.push(`OCO leg role unavailable for ${order.id}`);
						for (const [field, expected] of [
							["price", expectedPrice],
							["stopPrice", expectedStop],
						] as const) {
							if (expected === undefined) continue;
							if (order[field] === undefined) gaps.push(`Actual ${field} unavailable for ${order.id}`);
							else if (expected !== order[field])
								differences.push({ field, proposed: expected, actual: order[field] });
						}
					}
					const computedPrice = order.filled > 0 && order.cost > 0 ? order.cost / order.filled : NaN;
					const averageFillPrice = Number.isFinite(computedPrice) ? computedPrice : null;
					const deviation =
						referencePrice !== undefined && averageFillPrice !== null
							? (averageFillPrice / referencePrice - 1) * 10_000
							: NaN;
					return {
						order,
						differences,
						fillFraction: order.amount > 0 ? order.filled / order.amount : null,
						averageFillPrice,
						priceDifferenceFromPreparationBps: Number.isFinite(deviation) ? deviation : null,
						priceDifferenceSemantics:
							"Difference from the preparation snapshot includes market movement; not isolated execution slippage.",
					};
				}),
			};
		});
		return {
			intentId: intent.id,
			version: intent.version,
			proposedAt: intent.at,
			originalRationale: plan.versions[intent.version - 1].content.thesis,
			proposed: proposal,
			actual,
			gaps,
		};
	});
}
