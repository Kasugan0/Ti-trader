import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runIsolatedChild } from "../../../extensions/subagent/isolated-child.ts";
import {
	CANDLE_PROVIDER_KEY,
	RESEARCH_RUNTIME_KEY,
	type ResearchRuntime,
} from "../../../extensions/subagent/protocol.ts";
import { runSubagent, sessionStoreFor } from "../../../extensions/subagent/runner.ts";
import { subagentFixture } from "./subagent-fixture.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	delete (globalThis as Record<PropertyKey, unknown>)[RESEARCH_RUNTIME_KEY];
	delete (globalThis as Record<PropertyKey, unknown>)[CANDLE_PROVIDER_KEY];
});

describe("real isolated subagent with an offline faux provider", () => {
	it("resumes across separate processes, uses the futures bridge and persists cited evidence", async () => {
		const fixture = subagentFixture();
		try {
			const auth = join(fixture.directory, "auth");
			mkdirSync(auth);
			vi.stubEnv("PI_CODING_AGENT_DIR", auth);
			vi.stubEnv("TI_TEST_EXCHANGE_KEY", "fixture-secret");
			const hour = 3_600_000;
			const start = Math.floor(Date.now() / hour) * hour - 101 * hour;
			const candleProvider = vi.fn(async (_request: { symbol: string; timeframe: string; limit: number }) => ({
				candles: Array.from({ length: 100 }, (_, index) => ({
					timestamp: start + index * hour,
					open: 100 + index,
					high: 103 + index,
					low: 99 + index,
					close: 102 + index,
					volume: 50 + index,
				})),
				source: { venue: "fixture-exchange", market: "swap", kind: "session-klines", mode: "paper" },
			}));
			const runtime: ResearchRuntime = {
				scope: () => "fixture-paper-futures-account",
				tools: () => [
					{
						name: "calculate_indicators",
						description: "Fixture candles",
						parameters: Type.Object({ symbol: Type.String() }),
					},
				],
				execute: async () => {
					throw new Error("Indicators must use the candle bridge, not this executor");
				},
			};
			(globalThis as Record<PropertyKey, unknown>)[RESEARCH_RUNTIME_KEY] = runtime;
			(globalThis as Record<PropertyKey, unknown>)[CANDLE_PROVIDER_KEY] = candleProvider;
			const provider = fileURLToPath(new URL("./fixtures/subagent-faux-provider.ts", import.meta.url));
			const pids: number[] = [];
			const options = {
				...fixture.options,
				runChild: (request: Parameters<typeof runIsolatedChild>[0]) =>
					runIsolatedChild({
						...request,
						extensionPaths: [...request.extensionPaths, provider],
						onSpawn: (pid) => {
							pids.push(pid);
							request.onSpawn?.(pid);
						},
					}),
			};
			const ctx = { ...fixture.ctx, model: { provider: "ti-subagent-test", id: "offline" } };
			const first = await runSubagent({ agent: "technical-analyst", task: "first-marker" }, ctx, options);
			expect(first.isError, first.content[0].text).toBeUndefined();
			expect(first.details.results[0].report?.summary).toContain("users=1");
			expect(first.details.results[0].report?.summary).toContain("secret-visible=false");
			const id = first.details.results[0].sessionId!;
			const second = await runSubagent(
				{ sessionId: id, task: "second-marker: continue the analysis" },
				ctx,
				options,
			);
			expect(second.isError, second.content[0].text).toBeUndefined();
			expect(second.details.results[0].report?.summary).toContain("users=2");
			expect(second.details.results[0].report?.summary).toContain("remembers-first=true");
			expect(pids).toHaveLength(2);
			expect(pids[0]).not.toBe(pids[1]);
			expect(candleProvider).toHaveBeenCalledTimes(2);
			expect(candleProvider.mock.calls[0]?.[0]).toMatchObject({
				symbol: "BTC/USDT:USDT",
				timeframe: "1h",
				limit: 100,
			});
			const store = sessionStoreFor(ctx, fixture.options.sessionRoot);
			const saved = store.readRun(id);
			expect(saved.report?.findings[0].evidenceIds[0]).toContain(saved.runId);
			expect(JSON.stringify(saved.evidence)).toContain("fixture-exchange");
			expect(JSON.stringify(saved.evidence)).toContain('"market":"swap"');
			const file = store.historyPath(store.read(id));
			const history = SessionManager.open(file).buildSessionContext().messages;
			expect(history.filter((message) => message.role === "user")).toHaveLength(2);
			expect(readFileSync(file, "utf8")).toContain("second-marker");
		} finally {
			fixture.cleanup();
		}
	}, 60_000);
});
