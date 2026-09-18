import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerChildTools } from "../../../extensions/subagent/child-tools.ts";
import subagentExtension, { subagentContext } from "../../../extensions/subagent/index.ts";
import {
	type ChildManifest,
	type Evidence,
	extractEvidence,
	parseReport,
	RESEARCH_RUNTIME_KEY,
} from "../../../extensions/subagent/protocol.ts";
import { runSubagent, sessionStoreFor } from "../../../extensions/subagent/runner.ts";
import { childResult, extensionFixture, report, subagentFixture } from "./subagent-fixture.ts";

let fixture: ReturnType<typeof subagentFixture>;
let extension: ReturnType<typeof extensionFixture>;
beforeEach(() => {
	fixture = subagentFixture();
	extension = extensionFixture(fixture.directory);
	vi.stubEnv("TI_DATA_DIR", fixture.directory);
});
afterEach(() => {
	vi.unstubAllEnvs();
	delete (globalThis as Record<PropertyKey, unknown>)[RESEARCH_RUNTIME_KEY];
	fixture.cleanup();
});

function manifest(): ChildManifest {
	return {
		runId: randomUUID(),
		tools: [],
		bridge: false,
		allowedTools: ["calculate_indicators", "propose_order"],
		evidence: [],
	};
}

describe("child report protocol and budgets", () => {
	it("does not limit default turns or tool calls while preserving permissions", () => {
		registerChildTools(extension.api, manifest(), vi.fn());
		const abort = vi.fn();
		for (let index = 0; index < 1000; index++) {
			extension.emit("turn_start", {}, { abort });
			expect(extension.emit("tool_call", { toolName: "calculate_indicators" })).toBeUndefined();
		}
		expect(abort).not.toHaveBeenCalled();
		expect(extension.emit("tool_call", { toolName: "buy" })).toMatchObject({ block: true });
		expect(extension.emit("tool_call", { toolName: "finish_analysis" })).toBeUndefined();
	});
	it("blocks unauthorized calls, bounds tool/turn use and keeps finish_analysis available", () => {
		registerChildTools(extension.api, { ...manifest(), maxToolCalls: 1, maxTurns: 1 }, vi.fn());
		expect(extension.emit("tool_call", { toolName: "buy" })).toMatchObject({ block: true });
		expect(extension.emit("tool_call", { toolName: "calculate_indicators" })).toBeUndefined();
		expect(extension.emit("tool_call", { toolName: "calculate_indicators" })).toMatchObject({ block: true });
		expect(extension.emit("tool_call", { toolName: "finish_analysis" })).toBeUndefined();
		const abort = vi.fn();
		extension.emit("turn_start", {}, { abort });
		extension.emit("turn_start", {}, { abort });
		expect(abort).toHaveBeenCalledTimes(1);
	});
	it("wraps evidence, validates citations and terminates the run with a bounded report", async () => {
		const config = manifest();
		registerChildTools(extension.api, config, vi.fn());
		const wrapped = extension.emit("tool_result", {
			toolName: "calculate_indicators",
			toolCallId: "read-1",
			isError: false,
			content: [{ type: "text", text: "RSI=50" }],
			details: { rsi: 50 },
		});
		const evidence = extractEvidence(wrapped)!;
		expect(evidence).toMatchObject({ id: `${config.runId}:read-1`, result: { details: { rsi: 50 } } });
		const result = await extension.execute("finish_analysis", {
			...report(),
			findings: [{ claim: "RSI was 50", evidenceIds: [evidence.id] }],
		});
		expect(result).toMatchObject({ terminate: true, details: { findings: [{ evidenceIds: [evidence.id] }] } });
		expect(extension.emit("tool_call", { toolName: "calculate_indicators" })).toMatchObject({ block: true });
	});
	it("never permits failed or invented evidence to support a finding", async () => {
		registerChildTools(extension.api, manifest(), vi.fn());
		const wrapped = extension.emit("tool_result", {
			toolName: "calculate_indicators",
			toolCallId: "failed",
			isError: true,
			content: [],
			details: {},
		});
		const item = extractEvidence(wrapped)!;
		await expect(
			extension.execute("finish_analysis", {
				...report(),
				findings: [{ claim: "supported", evidenceIds: [item.id] }],
			}),
		).rejects.toThrow("unavailable evidence");
		expect(() =>
			parseReport({ ...report(), findings: [{ claim: "invented", evidenceIds: ["unknown"] }] }, []),
		).toThrow("unavailable evidence");
	});
	it("reads historical evidence without refreshing its timestamp and enforces byte limits", async () => {
		const item: Evidence = {
			id: "historical",
			tool: "get_price",
			observedAt: "2025-01-01T00:00:00Z",
			isError: false,
			result: { content: [], details: { price: 10 } },
		};
		registerChildTools(extension.api, { ...manifest(), evidence: [item] }, vi.fn());
		expect((await extension.execute("read_evidence", { evidenceId: item.id })).details).toEqual(item);
		await expect(extension.execute("read_evidence", { evidenceId: "foreign" })).rejects.toThrow("not available");
		await expect(
			extension.execute("finish_analysis", {
				...report(),
				findings: [{ claim: "still 10", evidenceIds: [item.id] }],
			}),
		).rejects.toThrow("refreshed");
		const long = {
			...report("市".repeat(600)),
			findings: Array.from({ length: 5 }, () => ({ claim: "市".repeat(300), evidenceIds: [item.id] })),
			risks: Array(4).fill("市".repeat(180)),
			invalidation: Array(4).fill("市".repeat(180)),
			unknowns: Array(4).fill("市".repeat(180)),
		};
		expect(() => parseReport(long, [item])).toThrow("exceeds 8192 bytes");
	});
	it("lets reviewers cite supplied evidence without a new observation", async () => {
		const item: Evidence = {
			id: "batch-evidence",
			tool: "calculate_indicators",
			observedAt: "2025-01-01T00:00:00Z",
			isError: false,
			result: { content: [], details: { rsi: 50 } },
		};
		registerChildTools(extension.api, { ...manifest(), evidence: [item], allowHistoricalFindings: true }, vi.fn());
		const result = await extension.execute("finish_analysis", {
			...report(),
			findings: [{ claim: "RSI was 50", evidenceIds: [item.id] }],
		});
		expect(result).toMatchObject({ terminate: true, details: { findings: [{ evidenceIds: [item.id] }] } });
	});
	it("proxies approved research services and blocks more than four proposals", async () => {
		const rpc = vi.fn(async () => ({ content: [{ type: "text", text: "fixture" }], details: {} }));
		registerChildTools(
			extension.api,
			{
				...manifest(),
				allowedTools: ["get_contract_stats", "propose_order"],
				tools: [
					{ name: "get_contract_stats", description: "Read", parameters: Type.Object({ symbol: Type.String() }) },
				],
			},
			rpc,
		);
		await extension.execute("get_contract_stats", { symbol: "BTC/USDT:USDT" });
		expect(rpc).toHaveBeenCalledWith("get_contract_stats", { symbol: "BTC/USDT:USDT" }, expect.any(AbortSignal));
		await expect(extension.execute("get_contract_stats", {})).rejects.toThrow("Invalid");
		for (let index = 0; index < 4; index++)
			expect(extension.emit("tool_call", { toolName: "propose_order" })).toBeUndefined();
		expect(extension.emit("tool_call", { toolName: "propose_order" })).toMatchObject({ block: true });
	});
});

describe("parent discovery and evidence tools", () => {
	it("discovers effective capabilities without putting full profiles into the parent prompt", async () => {
		subagentExtension(extension.api);
		expect([...extension.tools.keys()]).toEqual([
			"subagent",
			"subagent_agents",
			"subagent_sessions",
			"subagent_evidence",
		]);
		const result = await extension.execute("subagent_agents", {});
		expect(result.details).toMatchObject({
			total: 7,
			agents: expect.arrayContaining([
				expect.objectContaining({ name: "event-analyst", missingTools: expect.arrayContaining(["web_search"]) }),
				expect.objectContaining({
					name: "technical-analyst",
					tools: expect.arrayContaining(["calculate_indicators"]),
				}),
			]),
		});
	});
	it("lists private session handles and reads paged evidence with original timestamps", async () => {
		subagentExtension(extension.api);
		const ctx = subagentContext(extension.ctx);
		const item: Evidence = {
			id: "stored-evidence",
			tool: "calculate_indicators",
			observedAt: "2025-01-01T00:00:00Z",
			isError: false,
			result: {
				content: [{ type: "text", text: "x".repeat(20000) }],
				details: { source: { kind: "session-klines" } },
			},
		};
		const result = await runSubagent({ agent: "researcher", task: "inspect" }, ctx, {
			...fixture.options,
			sessionRoot: undefined,
			runChild: async () => ({
				...childResult(),
				evidence: [item],
				report: { ...report(), findings: [{ claim: "Fixture", evidenceIds: [item.id] }] },
			}),
		});
		const id = result.details.results[0].sessionId!;
		expect((await extension.execute("subagent_sessions", {})).details).toMatchObject({
			sessions: [{ sessionId: id, summary: expect.any(String) }],
		});
		const saved = await extension.execute("subagent_evidence", { sessionId: id });
		expect(saved.details).toMatchObject({
			status: "completed",
			evidence: [{ id: item.id, observedAt: item.observedAt }],
		});
		expect((await extension.execute("subagent_evidence", { sessionId: id, offset: 1 })).details).toMatchObject({
			total: 1,
			evidence: [],
			nextOffset: null,
		});
		const page = await extension.execute("subagent_evidence", { sessionId: id, evidenceId: item.id });
		expect(page.details).toMatchObject({ nextOffset: 16384, totalCharacters: expect.any(Number) });
		expect(JSON.stringify(page.details)).not.toContain(sessionStoreFor(ctx).directory);
		await expect(extension.execute("subagent_evidence", { sessionId: id, evidenceId: "foreign" })).rejects.toThrow(
			"not found",
		);
	});
});
