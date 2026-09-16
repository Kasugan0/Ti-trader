import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import marketResearchExtension from "../../../extensions/market-research/index.ts";
import type { IsolatedChildRequest } from "../../../extensions/subagent/isolated-child.ts";
import * as runner from "../../../extensions/subagent/runner.ts";
import { extensionFixture, persistChild, subagentFixture } from "./subagent-fixture.ts";

const runSubagent = runner.runSubagent;
let fixture: ReturnType<typeof subagentFixture>;
let extension: ReturnType<typeof extensionFixture>;
let requests: IsolatedChildRequest[];

beforeEach(() => {
	fixture = subagentFixture();
	extension = extensionFixture(fixture.directory);
	requests = [];
	vi.stubEnv("TI_DATA_DIR", fixture.directory);
	vi.spyOn(runner, "runSubagent").mockImplementation((params, ctx, options) =>
		runSubagent(params, ctx, {
			...options,
			userDir: fixture.options.userDir,
			runChild: async (request) => {
				requests.push(request);
				return persistChild(request, "technical result");
			},
		}),
	);
	marketResearchExtension(extension.api);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	fixture.cleanup();
});

describe("market_research shared persistent runtime", () => {
	it("accepts session futures symbols without exposing proposal tools", async () => {
		const parameters = extension.tools.get("market_research")!.parameters;
		expect(Value.Check(parameters, { question: "Analyze", symbol: "BTC/USDT:USDT", timeframe: "1h" })).toBe(true);
		const result = await extension.execute("market_research", {
			question: "Analyze",
			symbol: "BTC/USDT:USDT",
			timeframe: "1h",
		});
		expect(result.details).toMatchObject({ proposals: [], results: [{ report: { summary: "technical result" } }] });
		expect(requests[0].prompt).toContain("BTC/USDT:USDT");
		expect(requests[0].tools).not.toContain("propose_order");
		expect(requests[0].tools).toContain("finish_analysis");
	});
	it("lists owned technical conversations and continues the exact saved session", async () => {
		await extension.execute("market_research", { question: "first-marker" });
		const firstId = requests[0].sessionId;
		const listed = await extension.execute("market_research", { listSessions: true });
		expect(listed.details).toMatchObject({
			total: 1,
			sessions: [{ sessionId: firstId, summary: "technical result" }],
		});
		await extension.execute("market_research", { sessionId: firstId, question: "continue" });
		expect(requests[1].sessionId).toBe(firstId);
		expect(requests[1].sessionFile).toBe(requests[0].sessionFile);
	});
	it("keeps read-only mode even when a user role asks for proposals", async () => {
		writeFileSync(
			join(fixture.options.userDir, "technical-analyst.md"),
			"---\nname: technical-analyst\ndescription: override\ntools: calculate_indicators,propose_order\n---\nAnalyze.",
		);
		await extension.execute("market_research", { question: "analyze" });
		expect(requests[0].tools).not.toContain("propose_order");
		expect(requests[0].extensionPaths.some((file) => file.includes("child-orders"))).toBe(false);
	});
	it("makes invalid requests and missing sessions explicit errors", async () => {
		await expect(extension.execute("market_research", {})).rejects.toThrow("question is required");
		await expect(
			extension.execute("market_research", { listSessions: true, question: "conflicting" }),
		).rejects.toThrow("cannot be combined");
		await expect(
			extension.execute("market_research", {
				question: "continue",
				sessionId: "00000000-0000-4000-8000-000000000000",
			}),
		).rejects.toThrow("not found");
		expect(requests).toHaveLength(0);
	});
	it("paginates session discovery without starting another child", async () => {
		await extension.execute("market_research", { question: "one" });
		await extension.execute("market_research", { question: "two" });
		const result = await extension.execute("market_research", { listSessions: true, offset: 1, limit: 1 });
		expect(result.details).toMatchObject({
			total: 2,
			sessions: [expect.objectContaining({ sessionId: expect.any(String) })],
		});
		expect(requests).toHaveLength(2);
	});
});
