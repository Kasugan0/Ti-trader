import { stripVTControlCharacters } from "node:util";
import { keyText } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolExecutionComponent } from "../../../coding-agent/src/modes/interactive/components/tool-execution.ts";
import { getThemeByName, initTheme } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import type { TradingLanguage } from "../state.ts";
import { jsonResult } from "../tools/format.ts";
import { createTradingTools, NATIVE_TRADING_TOOL_NAMES } from "../tools/index.ts";
import { createTradingToolRenderers } from "../tools/render.ts";

type RenderContext = Parameters<NonNullable<ReturnType<typeof createTradingToolRenderers>["renderResult"]>>[3];

function context(overrides: Partial<RenderContext> = {}): RenderContext {
	return {
		args: {},
		toolCallId: "render-test",
		invalidate: vi.fn(),
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
}

function render(
	tool: string,
	data: unknown,
	options: {
		language?: TradingLanguage;
		expanded?: boolean;
		isError?: boolean;
		isPartial?: boolean;
		width?: number;
	} = {},
) {
	const theme = getThemeByName("dark");
	if (!theme) throw new Error("Missing theme");
	const colors = vi.spyOn(theme, "fg");
	const renderer = createTradingToolRenderers(tool, () => options.language ?? "en-US");
	if (!renderer.renderResult) throw new Error("Missing result renderer");
	const component = renderer.renderResult(
		jsonResult(data),
		{ expanded: options.expanded ?? false, isPartial: options.isPartial ?? false },
		theme,
		context({ isError: options.isError ?? false, isPartial: options.isPartial ?? false }),
	);
	const lines = component.render(options.width ?? 100);
	return { lines, text: lines.map(stripVTControlCharacters).join("\n"), colors };
}

const openOrder = {
	id: "order-1",
	symbol: "BTC/USDT",
	side: "buy",
	type: "limit",
	price: 100,
	amount: 1,
	filled: 0,
	remaining: 1,
	status: "open",
};

describe("trading tool presentation", () => {
	beforeEach(() => initTheme("dark", false));

	it("installs self-rendered presentation on all native tools without reading the runtime", () => {
		const provider = vi.fn(() => {
			throw new Error("Runtime must not be read during registration");
		});
		const tools = createTradingTools(provider);
		expect(tools.map((tool) => tool.name)).toEqual(NATIVE_TRADING_TOOL_NAMES);
		for (const tool of tools) {
			expect(tool.renderShell).toBe("self");
			expect(tool.renderCall).toBeTypeOf("function");
			expect(tool.renderResult).toBeTypeOf("function");
		}
		expect(provider).not.toHaveBeenCalled();
	});

	it("expands original request parameters without changing them", () => {
		const theme = getThemeByName("dark");
		if (!theme) throw new Error("Missing theme");
		const renderer = createTradingToolRenderers("buy", () => "zh-CN");
		if (!renderer.renderCall) throw new Error("Missing call renderer");
		const args = { symbol: "BTC/USDT", type: "limit", amount: 0.001, price: 95000 };
		const before = structuredClone(args);
		const text = renderer
			.renderCall(args, theme, context({ expanded: true }))
			.render(80)
			.join("\n");
		expect(stripVTControlCharacters(text)).toContain("请求参数");
		expect(stripVTControlCharacters(text)).toContain('"price": 95000');
		expect(args).toEqual(before);
	});

	it.each([
		["ok", "Preflight passed", "success"],
		["ok_with_warnings", "Review required", "warning"],
		["rejected", "Preflight rejected; do not submit", "error"],
		["unknown", "Preflight unknown; do not submit", "warning"],
		["unexpected", "Preflight unknown; do not submit", "warning"],
	])("distinguishes %s preflight from tool completion", (status, label, color) => {
		const result = render("check_order", { status, symbol: "BTC/USDT" });
		expect(result.text).toContain(label);
		expect(result.colors).toHaveBeenCalledWith(color, label);
		expect(result.text).toContain("no order submitted");
		expect(result.text).not.toContain("Request completed");
	});

	it("keeps all blocking and warning information visible and removes exact duplicates", () => {
		const result = render("check_order", {
			status: "unknown",
			blockingReasons: ["balance unavailable"],
			unknownReasons: ["balance unavailable"],
			nonBlockingWarnings: ["live fees unavailable"],
			warnings: ["live fees unavailable", "do not guess contract size"],
			dataQuality: { balance: false, market: true },
		});
		expect(result.text.match(/balance unavailable/g)).toHaveLength(1);
		expect(result.text.match(/live fees unavailable/g)).toHaveLength(1);
		expect(result.text).toContain("do not guess contract size");
		expect(result.text).toContain("Incomplete or unknown data: balance");
	});

	it.each([
		[{ status: "open", filled: 0, remaining: 1 }, "Open; not fully filled"],
		[{ status: "open", filled: 0.4, remaining: 0.6 }, "Partially filled; still open"],
		[{ status: "closed", filled: 1, remaining: 0 }, "Filled"],
		[{ status: "closed", filled: 0, remaining: 0 }, "Closed"],
		[{ status: "closed", filled: 0.4, remaining: 0.6 }, "Closed"],
		[{ status: "canceled", filled: 0.4, remaining: 0.6 }, "Cancelled"],
		[{ status: "rejected", filled: 0, remaining: 1 }, "Rejected"],
		[{ status: "expired", filled: 0, remaining: 1 }, "Expired"],
		[{ status: "unknown" }, "Order status unknown"],
	])("uses exchange order state instead of the outer ok status: %j", (state, label) => {
		const result = render("buy", { status: "ok", order: { ...openOrder, ...state }, executionId: "exec-1" });
		expect(result.text).toContain(label);
		expect(result.text).toContain("order-1");
		expect(result.text).toContain("exec-1");
		expect(result.text).toContain("Price: 100");
		if (label !== "Filled") expect(result.colors).not.toHaveBeenCalledWith("success", expect.any(String));
	});

	it("never presents omitted close-all quantity as a zero-size submission", () => {
		const result = render("sell", {
			status: "ok",
			order: { ...openOrder, side: "sell", closePosition: true, amount: 0, requestedAmount: 1.5 },
			executionConstraints: { exchangeConstraint: "Exchange omits quantity for close-all triggers" },
		});
		expect(result.text).toContain("Close entire matching position");
		expect(result.text).toContain("Amount: 1.5 BTC");
		expect(result.text).not.toContain("Amount: 0 BTC");
		expect(result.text).toContain("Exchange omits quantity");
	});

	it.each(["get_open_orders", "get_order_history"])("preserves close-all semantics in %s previews", (tool) => {
		const result = render(tool, {
			orders: [
				{ ...openOrder, closePosition: true, amount: 0, requestedAmount: null },
				{ ...openOrder, closePosition: true, amount: 0, requestedAmount: 1.5 },
			],
		});
		expect(result.text.match(/Close entire matching position/g)).toHaveLength(2);
		expect(result.text).toContain("Amount: Unavailable");
		expect(result.text).toContain("Amount: 1.5");
		expect(result.text).not.toContain("Amount: 0");
	});

	it("preserves recorded futures position direction instead of inferring it from magnitude", () => {
		const positions = ["LONG", "SHORT"].map((positionSide) => ({
			symbol: "BTC/USDT:USDT",
			positionSide,
			amount: 1,
			unrealizedPnl: 0,
		}));
		const result = render("get_positions", { positions });
		expect(result.text).toContain("Position side: LONG");
		expect(result.text).toContain("Position side: SHORT");
		const unknown = render("get_positions", { positions: [{ symbol: "BTC/USDT:USDT", amount: 1 }] });
		expect(unknown.text).toContain("Position side: Unavailable");
	});

	it("labels order-book depth as level counts rather than bid and ask prices", () => {
		const result = render(
			"get_order_book",
			{
				symbol: "BTC/USDT",
				spread: 1,
				bids: [
					{ price: 60000, amount: 1 },
					{ price: 59999, amount: 1 },
				],
				asks: [
					{ price: 60001, amount: 1 },
					{ price: 60002, amount: 1 },
				],
			},
			{ language: "zh-CN" },
		);
		expect(result.text).toContain("买盘档数: 2");
		expect(result.text).toContain("卖盘档数: 2");
		expect(result.text).not.toContain("买价: 2");
		expect(result.text).not.toContain("卖价: 2");
	});

	it("preserves independent OCO leg outcomes and preflight warnings", () => {
		const result = render("place_oco", {
			status: "ok",
			orders: [openOrder, { ...openOrder, id: "leg-2", status: "rejected" }],
			preflight: { warnings: ["Fees unknown"] },
		});
		expect(result.text).toContain("Open; not fully filled");
		expect(result.text).toContain("Rejected");
		expect(result.text).toContain("leg-2");
		expect(result.text).toContain("Fees unknown");
	});

	it("routes ambiguous submission output to recovery rather than retry", () => {
		for (const data of [{ status: "ok" }, { status: "ok", order: { ...openOrder, status: "unknown" } }]) {
			const result = render("buy", data);
			expect(result.text).toContain("/recovery");
			expect(result.text).toContain("never resubmit");
		}
	});

	it("keeps rejection and partial fill rows visible past the normal three-row preview", () => {
		const orders = Array.from({ length: 6 }, (_, index) => ({ ...openOrder, id: `order-${index}` }));
		orders[4] = { ...orders[4], status: "rejected" };
		orders[5] = { ...orders[5], filled: 0.5, remaining: 0.5 };
		const result = render("get_open_orders", { orders });
		expect(result.text).toContain("order-4");
		expect(result.text).toContain("order-5");
		expect(result.text).toContain("1 more in original output");
	});

	it("keeps unavailable totals and missing lists distinct from valid zero values", () => {
		const missing = render("get_balance", { totalQuoteValue: null, quoteCurrency: "USDT" });
		expect(missing.text).toContain("Total valuation: Unavailable USDT");
		expect(missing.text).toContain("Unavailable records");
		expect(missing.text).not.toContain("0 records");
		const empty = render("get_balance", { totalQuoteValue: 0, quoteCurrency: "USDT", balances: [] });
		expect(empty.text).toContain("Total valuation: 0 USDT");
		expect(empty.text).toContain("0 records");
	});

	it("does not turn available capabilities into authorization or hide an inactive market", () => {
		const ready = render("get_trading_capabilities", { overallStatus: "ready" });
		expect(ready.text).toContain("not an order authorization");
		expect(ready.colors).not.toHaveBeenCalledWith("success", expect.any(String));
		const unknown = render("get_trading_capabilities", { overallStatus: "unknown" }, { language: "zh-CN" });
		expect(unknown.text).toContain("部分交易能力未知");
		const inactive = render("get_market_info", { symbol: "BTC/USDT", active: false });
		expect(inactive.text).toContain("Market inactive; do not submit");
	});

	it("compresses candle payloads, exposes forming candles, and restores full raw output on expansion", () => {
		const data = {
			mode: "paper",
			exchange: "binance",
			symbol: "BTC/USDT",
			timeframe: "1h",
			candles: Array.from({ length: 100 }, (_, index) => ({
				time: `candle-${index}`,
				closed: index < 99,
				open: 100,
				high: 102,
				low: 99,
				close: 101,
			})),
		};
		const compact = render("get_klines", data);
		expect(compact.lines.length).toBeLessThanOrEqual(6);
		expect(compact.text).toContain("100 records");
		expect(compact.text).toContain("still forming");
		expect(compact.text).toContain(keyText("app.tools.expand"));
		expect(compact.text).not.toContain('"open":');
		const expanded = render("get_klines", data, { expanded: true });
		expect(expanded.text).toContain('"open": 100');
		expect(expanded.text).toContain("candle-0");
		expect(expanded.text).toContain("candle-99");
	});

	it("renders real tool errors and partial output without claiming business success", () => {
		const error = render("buy", { status: "ok", reason: "request failed; check /recovery" }, { isError: true });
		expect(error.text).toContain("Tool failed");
		expect(error.text).toContain("check /recovery");
		expect(error.colors).not.toHaveBeenCalledWith("success", expect.any(String));
		const partial = render("check_order", { status: "ok" }, { isPartial: true });
		expect(partial.text).toContain("Running");
		expect(partial.text).not.toContain("Preflight passed");
	});

	it.each([20, 40, 80, 140])("preserves Chinese warnings and critical fields at %i columns", (width) => {
		const result = render(
			"check_order",
			{
				status: "unknown",
				symbol: "BTC/USDT:USDT",
				resolution: {
					amount: 0.001,
					estimatedNotional: 100,
					quoteCurrency: "USDT",
					referencePrice: 100000,
					referenceTime: "2026-09-14T06:00:00Z",
				},
				warnings: ["请核对交易所订单，不要重复提交。"],
			},
			{ language: "zh-CN", width },
		);
		for (const line of result.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		const text = result.text.replace(/\s+/g, "");
		expect(text).toContain("预检结果未知，不可提交");
		expect(text).toContain("请核对交易所订单，不要重复提交。");
		expect(text).toContain("0.001BTC");
		expect(text).toContain("100USDT");
	});

	it("retains the recorded execution scope instead of relabeling history with the current account", () => {
		const data = { mode: "paper", exchange: "okx", symbol: "BTC/USDT", last: 100, bid: 99, ask: 101 };
		const result = render("get_price", data, { language: "zh-CN" });
		expect(result.text).toContain("paper · okx");
		expect(result.text).not.toContain("binance");
		expect(result.text).not.toContain("live");
	});

	it("bypasses the shared success background for a business rejection", () => {
		const definition = createTradingTools().find((tool) => tool.name === "check_order");
		if (!definition) throw new Error("Missing check_order");
		const tui = new TuiMainScreen(new ProcessTerminal());
		const component = new ToolExecutionComponent(
			"check_order",
			"test",
			{},
			{ showImages: false },
			{
				...definition,
				...createTradingToolRenderers("check_order", () => "en-US"),
			},
			tui,
			process.cwd(),
		);
		component.updateResult({ ...jsonResult({ status: "rejected", reason: "quota exceeded" }), isError: false });
		const text = component.render(100).join("\n");
		expect(stripVTControlCharacters(text)).toContain("Preflight rejected; do not submit");
		expect(stripVTControlCharacters(text)).toContain("quota exceeded");
		const theme = getThemeByName("dark");
		if (!theme) throw new Error("Missing theme");
		const successBackground = theme.bg("toolSuccessBg", "").match(/^\x1b\[[\d;]+m/)?.[0];
		if (successBackground) expect(text).not.toContain(successBackground);
	});
});
