import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { PROPOSE_ORDER_TOOL } from "./child-orders.ts";
import {
	analysisBudgetSchema,
	asRecord,
	assertFreshFindings,
	CANDLE_PROVIDER_KEY,
	type CandleRequest,
	type ChildManifest,
	type Evidence,
	evidenceSchema,
	FINISH_ANALYSIS_TOOL,
	FORCE_KILL_DELAY_MS,
	LAB_TOOLS,
	parseReport,
	READ_ONLY_TOOLS,
	type ResearchResult,
	reportSchema,
} from "./protocol.ts";

type Rpc = (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;

export function registerChildTools(pi: ExtensionAPI, manifest: ChildManifest, call: Rpc): void {
	const allowed = new Set([...manifest.allowedTools, FINISH_ANALYSIS_TOOL, "read_evidence"]);
	const evidence = new Map(manifest.evidence.map((item) => [item.id, item]));
	let toolCalls = 0;
	let turns = 0;
	let finished = false;
	let proposals = 0;
	if (manifest.bridge) {
		(globalThis as Record<PropertyKey, unknown>)[CANDLE_PROVIDER_KEY] = (request: CandleRequest) =>
			call(
				"__candles",
				{ symbol: request.symbol, timeframe: request.timeframe, limit: request.limit },
				request.signal,
			);
	}
	for (const tool of manifest.tools) {
		if (!allowed.has(tool.name) || !(READ_ONLY_TOOLS as readonly string[]).includes(tool.name))
			throw new Error(`Invalid child tool manifest: ${tool.name}`);
		if ((LAB_TOOLS as readonly string[]).includes(tool.name)) continue;
		pi.registerTool({
			...tool,
			label: tool.name,
			async execute(_id, args, signal) {
				if (!Value.Check(tool.parameters, args)) throw new Error(`Invalid ${tool.name} arguments`);
				const result = asRecord(await call(tool.name, args, signal));
				if (!result || !Array.isArray(result.content)) throw new Error("Invalid research bridge response");
				return result as ResearchResult;
			},
		});
	}
	pi.on("turn_start", (_event, ctx) => {
		if (manifest.maxTurns !== undefined && ++turns > manifest.maxTurns) ctx.abort();
	});
	pi.on("tool_call", (event) => {
		if (!allowed.has(event.toolName)) return { block: true, reason: "Tool is outside this specialist's allowlist" };
		if (finished) return { block: true, reason: "This analysis run is already finished" };
		if (event.toolName === PROPOSE_ORDER_TOOL && ++proposals > 4)
			return { block: true, reason: "At most four order proposals are allowed per research run" };
		if (
			event.toolName !== FINISH_ANALYSIS_TOOL &&
			manifest.maxToolCalls !== undefined &&
			++toolCalls > manifest.maxToolCalls
		)
			return {
				block: true,
				reason: "Research tool budget exhausted; finish_analysis must report remaining unknowns",
			};
		return undefined;
	});
	pi.on("tool_result", (event) => {
		if (
			event.toolName === FINISH_ANALYSIS_TOOL ||
			event.toolName === PROPOSE_ORDER_TOOL ||
			event.toolName === "read_evidence"
		)
			return;
		const record: Evidence = {
			id: `${manifest.runId}:${event.toolCallId}`,
			tool: event.toolName,
			observedAt: new Date().toISOString(),
			isError: event.isError,
			result: {
				content: event.content.filter((part) => part.type === "text"),
				details: event.details,
				isError: event.isError,
			},
		};
		evidence.set(record.id, record);
		const reference = { id: record.id, tool: record.tool, observedAt: record.observedAt, isError: record.isError };
		return {
			content: [{ type: "text", text: JSON.stringify({ evidence: reference }) }, ...event.content],
			details: { evidence: reference, data: event.details },
		};
	});
	pi.registerTool({
		name: "read_evidence",
		label: "Read Evidence",
		description:
			"Read a supplied or current-run evidence item by ID. Old observations remain old; this does not refresh market data.",
		parameters: Type.Object({ evidenceId: Type.String({ minLength: 1, maxLength: 160 }) }),
		async execute(_id, params) {
			const item = evidence.get(params.evidenceId);
			if (!item) throw new Error("Evidence ID is not available in this research context");
			return { content: [{ type: "text", text: JSON.stringify(item) }], details: item };
		},
	});
	pi.registerTool({
		name: FINISH_ANALYSIS_TOOL,
		label: "Finish Analysis",
		description:
			"Finish this research invocation with a concise structured report. Cite evidence IDs returned by tools or supplied reports. Historical data must be refreshed. Call this tool alone after research; it never authorizes a trade.",
		parameters: reportSchema,
		async execute(_id, params) {
			const report = parseReport(params, [...evidence.values()]);
			if (!manifest.allowHistoricalFindings)
				assertFreshFindings(report, new Set(manifest.evidence.map((item) => item.id)));
			finished = true;
			return {
				content: [{ type: "text", text: JSON.stringify(report) }],
				details: report,
				terminate: true,
			};
		},
	});
}

export default function childToolsExtension(pi: ExtensionAPI): void {
	const file = process.env.TI_SUBAGENT_MANIFEST;
	if (!file || !process.send) throw new Error("Child research tools require supervised IPC");
	const manifest = JSON.parse(readFileSync(file, "utf8")) as ChildManifest;
	if (
		typeof manifest.runId !== "string" ||
		manifest.runId.length > 64 ||
		manifest.runId.length === 0 ||
		typeof manifest.bridge !== "boolean" ||
		!Array.isArray(manifest.tools) ||
		manifest.tools.some(
			(tool) =>
				!asRecord(tool) ||
				typeof tool.name !== "string" ||
				typeof tool.description !== "string" ||
				!asRecord(tool.parameters),
		) ||
		!Array.isArray(manifest.allowedTools) ||
		manifest.allowedTools.some(
			(name) => !(READ_ONLY_TOOLS as readonly string[]).includes(name) && name !== PROPOSE_ORDER_TOOL,
		) ||
		!Array.isArray(manifest.evidence) ||
		manifest.evidence.some((item) => !Value.Check(evidenceSchema, item)) ||
		(manifest.allowHistoricalFindings !== undefined && typeof manifest.allowHistoricalFindings !== "boolean") ||
		!Value.Check(analysisBudgetSchema, {
			maxToolCalls: manifest.maxToolCalls,
			maxTurns: manifest.maxTurns,
			timeoutMs: manifest.timeoutMs,
		})
	)
		throw new Error("Invalid child research manifest");
	let sequence = 0;
	const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
	const onMessage = (message: unknown): void => {
		const event = asRecord(message);
		if (event?.kind !== "ti-subagent-result" || typeof event.id !== "string") return;
		const item = pending.get(event.id);
		if (!item) return;
		pending.delete(event.id);
		item.cleanup();
		if (typeof event.error === "string") item.reject(new Error(event.error));
		else item.resolve(event.result);
		if (pending.size === 0) process.channel?.unref();
	};
	process.on("message", onMessage);
	process.channel?.unref();
	let forceKill: ReturnType<typeof setTimeout> | undefined;
	const stop = (): void => {
		for (const item of pending.values()) {
			item.cleanup();
			item.reject(new Error("Research supervisor disconnected"));
		}
		pending.clear();
		if (forceKill) return;
		process.kill(process.pid, "SIGTERM");
		forceKill = setTimeout(() => process.kill(process.pid, "SIGKILL"), FORCE_KILL_DELAY_MS);
		forceKill.unref?.();
	};
	process.once("disconnect", stop);
	const timeout =
		manifest.timeoutMs === undefined ? undefined : setTimeout(stop, manifest.timeoutMs + FORCE_KILL_DELAY_MS);
	timeout?.unref();
	pi.on("session_shutdown", () => {
		clearTimeout(timeout);
		process.removeListener("message", onMessage);
		process.removeListener("disconnect", stop);
		for (const item of pending.values()) {
			item.cleanup();
			item.reject(new Error("Research session shut down"));
		}
		pending.clear();
		process.channel?.unref();
	});
	registerChildTools(pi, manifest, (name, args, signal) => {
		signal?.throwIfAborted();
		if (!process.connected) return Promise.reject(new Error("Research supervisor disconnected"));
		const id = `${manifest.runId}:${sequence++}`;
		return new Promise((resolve, reject) => {
			const abort = (): void => {
				pending.delete(id);
				reject(new Error("Research request cancelled"));
				if (pending.size === 0) process.channel?.unref();
			};
			pending.set(id, {
				resolve,
				reject,
				cleanup: () => signal?.removeEventListener("abort", abort),
			});
			signal?.addEventListener("abort", abort, { once: true });
			process.channel?.ref();
			process.send!({ kind: "ti-subagent-call", id, name, args }, (error) => {
				if (!error) return;
				const item = pending.get(id);
				if (!item) return;
				pending.delete(id);
				item.cleanup();
				item.reject(new Error("Research bridge send failed", { cause: error }));
				if (pending.size === 0) process.channel?.unref();
			});
		});
	});
}
