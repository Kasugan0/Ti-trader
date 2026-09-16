import { randomUUID } from "node:crypto";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { failureCode } from "./autonomous/runtime.ts";
import {
	depthSchema,
	fundingHistorySchema,
	futuresSymbolSchema,
	getPriceSchema,
	marketInfoSchema,
	topMarketsSchema,
} from "./tools/schemas.ts";

/** Shared with the separately packaged subagent extension. */
const RESEARCH_RUNTIME_KEY = Symbol.for("ti.subagent.runtime");
type ResearchAdapter = Pick<ToolDefinition, "name" | "description" | "parameters"> & {
	execute(args: unknown, signal: AbortSignal): ReturnType<ToolDefinition["execute"]>;
};

export function installResearchRuntime(
	session: Pick<AgentSession, "agent">,
	scope: () => string,
	options: { ownerId?: string; extraTools?: ResearchAdapter[] } = {},
): () => void {
	const nativeNames = new Set([
		"get_price",
		"get_order_book",
		"get_market_info",
		"get_top_markets",
		"get_contract_stats",
		"get_funding_rate_history",
		"calculate_indicators",
		"evaluate_strategy",
		"screen_markets",
		"simulate_rule",
		"web_search",
		"fetch_source",
		"zhihu_global_search",
		"freqtrade_status",
		"freqtrade_backtest",
		"freqtrade_signals",
	]);
	const tools = () =>
		[...session.agent.state.tools, ...(options.extraTools ?? [])].filter((tool) => nativeNames.has(tool.name));
	const bridge = {
		ownerId: options.ownerId,
		scope,
		tools: () => tools().map(({ name, description, parameters }) => ({ name, description, parameters })),
		async execute(name: string, args: unknown, signal: AbortSignal) {
			signal.throwIfAborted();
			const activeScope = scope();
			const extra = options.extraTools?.find((tool) => tool.name === name);
			const active = session.agent.state.tools.find((tool) => tool.name === name);
			const tool = extra ?? active;
			if (!nativeNames.has(name) || !tool) throw new Error(`Read-only research tool unavailable: ${name}`);
			if (!Value.Check(tool.parameters, args)) throw new Error(`Invalid research arguments: ${name}`);
			try {
				const result = extra
					? await extra.execute(args, signal)
					: await active!.execute(randomUUID(), args, signal);
				signal.throwIfAborted();
				if (scope() !== activeScope) throw new Error("Research account scope changed");
				return {
					content: name.startsWith("get_")
						? [{ type: "text" as const, text: JSON.stringify(result.details) }]
						: result.content.filter((part) => part.type === "text"),
					details: result.details,
				};
			} catch (error) {
				throw new Error(`Research ${name} failed: ${failureCode(error)}`);
			}
		},
	};
	const holders = globalThis as Record<PropertyKey, unknown>;
	holders[RESEARCH_RUNTIME_KEY] = bridge;
	return () => {
		if (holders[RESEARCH_RUNTIME_KEY] === bridge) delete holders[RESEARCH_RUNTIME_KEY];
	};
}

export function autonomousResearchTools(query: (args: Record<string, unknown>) => Promise<unknown>): ResearchAdapter[] {
	const definitions = [
		["get_price", "ticker", getPriceSchema],
		["get_order_book", "book", depthSchema],
		["get_market_info", "market-info", marketInfoSchema],
		["get_top_markets", "markets", topMarketsSchema],
		["get_contract_stats", "contract-stats", futuresSymbolSchema],
		["get_funding_rate_history", "funding-history", fundingHistorySchema],
	] as const;
	return definitions.map(([name, operation, parameters]) => ({
		name,
		description: `Read-only ${operation} from this autonomous account's market-data service.`,
		parameters,
		async execute(args, signal) {
			signal.throwIfAborted();
			if (!Value.Check(parameters, args)) throw new Error(`Invalid ${name} arguments`);
			const result = await query({ ...(args as Record<string, unknown>), operation });
			signal.throwIfAborted();
			if (!result || typeof result !== "object" || !("status" in result) || result.status !== "ok")
				throw new Error(`Autonomous ${operation} data unavailable`);
			return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
		},
	}));
}
