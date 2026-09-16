import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const RESEARCH_RUNTIME_KEY = Symbol.for("ti.subagent.runtime");
export const CANDLE_PROVIDER_KEY = Symbol.for("ti.marketLab.candleProvider");
export const FINISH_ANALYSIS_TOOL = "finish_analysis";
export const FORCE_KILL_DELAY_MS = 2_000;
export const REPORT_BYTES = 8 * 1024;
export const EVIDENCE_BYTES = 256 * 1024;
export const LAB_TOOLS = ["calculate_indicators", "evaluate_strategy", "screen_markets", "simulate_rule"] as const;
export const READ_ONLY_TOOLS = [
	...LAB_TOOLS,
	"get_price",
	"get_order_book",
	"get_market_info",
	"get_top_markets",
	"get_contract_stats",
	"get_funding_rate_history",
	"web_search",
	"fetch_source",
	"zhihu_global_search",
	"freqtrade_status",
	"freqtrade_backtest",
	"freqtrade_signals",
] as const;

export const analysisBudgetSchema = Type.Object({
	// Keep the optional deadline plus the child's two-second watchdog within Node's timer range.
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_481_647 })),
	maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
	maxToolCalls: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
	maxTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
});
export type AnalysisBudget = Static<typeof analysisBudgetSchema>;

export const reportSchema = Type.Object(
	{
		summary: Type.String({ minLength: 1, maxLength: 600 }),
		findings: Type.Array(
			Type.Object({
				claim: Type.String({ minLength: 1, maxLength: 300 }),
				evidenceIds: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 1, maxItems: 4 }),
			}),
			{ maxItems: 5 },
		),
		risks: Type.Array(Type.String({ maxLength: 180 }), { maxItems: 4 }),
		invalidation: Type.Array(Type.String({ maxLength: 180 }), { maxItems: 4 }),
		unknowns: Type.Array(Type.String({ maxLength: 180 }), { maxItems: 4 }),
		bias: Type.Union([Type.Literal("long"), Type.Literal("short"), Type.Literal("none")]),
	},
	{ additionalProperties: false },
);
export type AnalysisReport = Static<typeof reportSchema>;
export type ResearchResult = {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
	isError?: boolean;
};
export type Evidence = {
	id: string;
	tool: string;
	observedAt: string;
	isError: boolean;
	result: ResearchResult;
};
export const evidenceSchema = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 160 }),
	tool: Type.String({ minLength: 1, maxLength: 80 }),
	observedAt: Type.String(),
	isError: Type.Boolean(),
	result: Type.Object({
		content: Type.Array(Type.Object({ type: Type.Literal("text"), text: Type.String() })),
		details: Type.Optional(Type.Unknown()),
		isError: Type.Optional(Type.Boolean()),
	}),
});
export type ResearchRuntime = {
	/** Stable autonomous ownership; interactive callers use their parent session ID. */
	ownerId?: string;
	scope(): string;
	tools(): ResearchTool[];
	execute(name: string, args: unknown, signal: AbortSignal): Promise<ResearchResult>;
};
export type CandleRequest = { symbol: string; timeframe: string; limit: number; signal?: AbortSignal };
export type CandleProvider = (request: CandleRequest) => Promise<unknown>;
export type ResearchTool = Pick<ToolInfo, "name" | "description" | "parameters">;
export type ChildManifest = Pick<AnalysisBudget, "maxToolCalls" | "maxTurns" | "timeoutMs"> & {
	runId: string;
	tools: ResearchTool[];
	bridge: boolean;
	allowedTools: string[];
	evidence: Evidence[];
};

export function researchRuntime(): ResearchRuntime | undefined {
	const value = (globalThis as Record<PropertyKey, unknown>)[RESEARCH_RUNTIME_KEY];
	if (value === undefined) return undefined;
	if (
		!value ||
		typeof value !== "object" ||
		!("scope" in value) ||
		typeof value.scope !== "function" ||
		!("tools" in value) ||
		typeof value.tools !== "function" ||
		!("execute" in value) ||
		typeof value.execute !== "function"
	)
		throw new Error("Invalid Ti research runtime");
	return value as ResearchRuntime;
}

export function parseReport(value: unknown, evidence: readonly Pick<Evidence, "id" | "isError">[]): AnalysisReport {
	if (!Value.Check(reportSchema, value)) throw new Error("Invalid analysis report schema");
	const report = value;
	if (Buffer.byteLength(JSON.stringify(report), "utf8") > REPORT_BYTES)
		throw new Error(`Analysis report exceeds ${REPORT_BYTES} bytes; shorten the report`);
	const available = new Map(evidence.map((item) => [item.id, item]));
	for (const finding of report.findings) {
		for (const id of finding.evidenceIds) {
			const source = available.get(id);
			if (!source || source.isError) throw new Error(`Finding cites unavailable evidence: ${id}`);
		}
	}
	return report;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function extractEvidence(value: unknown): Evidence | undefined {
	const result = asRecord(value);
	const details = asRecord(result?.details);
	const evidence = asRecord(details?.evidence);
	if (
		!result ||
		!evidence ||
		typeof evidence.id !== "string" ||
		typeof evidence.tool !== "string" ||
		typeof evidence.observedAt !== "string" ||
		typeof evidence.isError !== "boolean" ||
		!Array.isArray(result.content)
	)
		return undefined;
	const content = result.content.flatMap((item: unknown) => {
		const part = asRecord(item);
		return part?.type === "text" && typeof part.text === "string" ? [{ type: "text" as const, text: part.text }] : [];
	});
	return {
		id: evidence.id,
		tool: evidence.tool,
		observedAt: evidence.observedAt,
		isError: evidence.isError,
		result: { content, details: details?.data, isError: evidence.isError },
	};
}
