import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResearchAccess } from "../../../extensions/subagent/bridge.ts";
import {
	CANDLE_PROVIDER_KEY,
	type CandleRequest,
	RESEARCH_RUNTIME_KEY,
	type ResearchRuntime,
	researchRuntime,
} from "../../../extensions/subagent/protocol.ts";
import { sessionStoreFor } from "../../../extensions/subagent/runner.ts";
import { autonomousResearchTools, installResearchRuntime } from "../src/research-bridge.ts";
import { subagentFixture } from "./subagent-fixture.ts";

const holders = globalThis as Record<PropertyKey, unknown>;
const streamFn = (): never => {
	throw new Error("Bridge tests must not invoke a model");
};
let fixture: ReturnType<typeof subagentFixture>;
beforeEach(() => {
	fixture = subagentFixture();
});
afterEach(() => {
	delete holders[RESEARCH_RUNTIME_KEY];
	delete holders[CANDLE_PROVIDER_KEY];
	vi.useRealTimers();
	fixture.cleanup();
});

describe("parent read-only research bridge", () => {
	it("exposes only approved reads and forwards full native data rather than UI cards", async () => {
		const parameters = Type.Object({ symbol: Type.String() });
		const execute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "Price card" }],
			details: { price: 123 },
		}));
		const tools: AgentTool[] = [
			{ name: "get_price", label: "Price", description: "Read", parameters, execute },
			{ name: "buy", label: "Buy", description: "Trade", parameters, execute },
		];
		installResearchRuntime({ agent: new Agent({ streamFn, initialState: { tools } }) }, () => "account");
		const runtime = researchRuntime()!;
		expect(runtime.tools().map((tool) => tool.name)).toEqual(["get_price"]);
		expect(await runtime.execute("get_price", { symbol: "BTC/USDT" }, new AbortController().signal)).toMatchObject({
			content: [{ text: '{"price":123}' }],
			details: { price: 123 },
		});
		await expect(runtime.execute("buy", {}, new AbortController().signal)).rejects.toThrow("unavailable");
		await expect(runtime.execute("get_price", {}, new AbortController().signal)).rejects.toThrow(
			"Invalid research arguments",
		);
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it("sanitizes service failures and rejects scope changes during retrieval", async () => {
		let scope = "first";
		const execute = vi.fn(async () => {
			scope = "second";
			return { content: [], details: {} };
		});
		const agent = new Agent({
			streamFn,
			initialState: {
				tools: [{ name: "get_price", label: "Price", description: "Read", parameters: Type.Object({}), execute }],
			},
		});
		installResearchRuntime({ agent }, () => scope);
		await expect(researchRuntime()!.execute("get_price", {}, new AbortController().signal)).rejects.toThrow(
			"operation-failed",
		);
		execute.mockRejectedValue(new Error("fixture-secret-value"));
		await expect(researchRuntime()!.execute("get_price", {}, new AbortController().signal)).rejects.not.toThrow(
			"fixture-secret-value",
		);
	});
	it("keeps autonomous ownership stable across parent workers but isolates accounts", () => {
		let scope = "account-a";
		const agent = new Agent({ streamFn });
		const removeOld = installResearchRuntime({ agent }, () => scope, { ownerId: "autonomous" });
		const first = sessionStoreFor(fixture.ctx, fixture.options.sessionRoot).directory;
		const removeNew = installResearchRuntime({ agent }, () => scope, { ownerId: "autonomous" });
		removeOld();
		expect(researchRuntime()).toBeDefined();
		expect(
			sessionStoreFor({ ...fixture.ctx, parentSessionId: "next-worker" }, fixture.options.sessionRoot).directory,
		).toBe(first);
		scope = "account-b";
		expect(sessionStoreFor(fixture.ctx, fixture.options.sessionRoot).directory).not.toBe(first);
		removeNew();
		expect(researchRuntime()).toBeUndefined();
	});
	it("maps autonomous market queries without accepting an injected operation", async () => {
		const query = vi.fn(async () => ({ status: "ok", data: { price: 123 } }));
		const adapters = autonomousResearchTools(query);
		expect(adapters.map((tool) => tool.name)).toEqual([
			"get_price",
			"get_order_book",
			"get_market_info",
			"get_top_markets",
			"get_contract_stats",
			"get_funding_rate_history",
		]);
		await adapters[0].execute({ symbol: "BTC/USDT", operation: "buy" }, new AbortController().signal);
		expect(query).toHaveBeenCalledWith({ symbol: "BTC/USDT", operation: "ticker" });
		query.mockResolvedValueOnce({ status: "unknown", data: { price: 0 } });
		await expect(adapters[0].execute({ symbol: "BTC/USDT" }, new AbortController().signal)).rejects.toThrow(
			"unavailable",
		);
	});
});

describe("shared snapshot and child access", () => {
	const runtime: ResearchRuntime = {
		scope: () => "account",
		tools: () => [],
		execute: async () => {
			throw new Error("Unexpected native request");
		},
	};
	it("supplies internal lab capabilities without making parent lab tools mandatory", () => {
		holders[CANDLE_PROVIDER_KEY] = async () => ({});
		expect(new ResearchAccess(runtime).available()).toContain("calculate_indicators");
		expect(new ResearchAccess(runtime).available()).not.toContain("buy");
	});
	it("shares session futures candles while excluding bars after the batch cutoff", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
		const hour = 3_600_000;
		const now = Date.now();
		const provider = vi.fn(async (_request: CandleRequest) => ({
			candles: [{ timestamp: now - hour }, { timestamp: now }],
			source: { kind: "session-klines", venue: "fixture", market: "swap" },
		}));
		holders[CANDLE_PROVIDER_KEY] = provider;
		const access = new ResearchAccess(runtime);
		vi.advanceTimersByTime(hour);
		const request = { symbol: "BTC/USDT:USDT", timeframe: "1h", limit: 20 };
		const result = await access.call("__candles", request, ["calculate_indicators"], new AbortController().signal);
		expect(result).toMatchObject({
			candles: [{ timestamp: now - hour }],
			source: { market: "swap", snapshotAt: "2026-01-01T12:00:00.000Z" },
		});
		await access.call("__candles", request, ["evaluate_strategy"], new AbortController().signal);
		expect(provider).toHaveBeenCalledTimes(1);
	});
	it("does not let a cancelled child cancel a sibling's shared candle request", async () => {
		let finish: ((value: unknown) => void) | undefined;
		const provider = vi.fn(
			(_request: CandleRequest) =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		holders[CANDLE_PROVIDER_KEY] = provider;
		const batch = new AbortController();
		const access = new ResearchAccess(runtime, batch.signal);
		const first = new AbortController();
		const request = { symbol: "BTC/USDT:USDT", timeframe: "1h", limit: 20 };
		const cancelled = access.call("__candles", request, ["calculate_indicators"], first.signal);
		const sibling = access.call("__candles", request, ["calculate_indicators"], new AbortController().signal);
		first.abort();
		await expect(cancelled).rejects.toThrow("cancelled");
		expect(provider.mock.calls[0][0].signal).toBe(batch.signal);
		expect(batch.signal.aborted).toBe(false);
		finish!({ candles: [], source: { kind: "session-klines", market: "swap" } });
		await expect(sibling).resolves.toMatchObject({ source: { market: "swap" } });
		expect(provider).toHaveBeenCalledTimes(1);
	});
	it("rejects unauthorized tools, invalid candle arguments and a public-spot substitution", async () => {
		holders[CANDLE_PROVIDER_KEY] = async () => ({ candles: [], source: { kind: "binance-public-klines" } });
		const access = new ResearchAccess(runtime);
		const signal = new AbortController().signal;
		await expect(access.call("buy", {}, ["calculate_indicators"], signal)).rejects.toThrow("not allowed");
		await expect(access.call("__candles", {}, ["calculate_indicators"], signal)).rejects.toThrow(
			"Invalid child candle request",
		);
		await expect(
			access.call(
				"__candles",
				{ symbol: "BTC/USDT:USDT", timeframe: "1h", limit: 20 },
				["calculate_indicators"],
				signal,
			),
		).rejects.toThrow("non-session data");
	});
});
