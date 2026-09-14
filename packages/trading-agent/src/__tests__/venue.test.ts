import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { getThemeByName } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { formatTradingStatus, formatTradingVenue, renderTradingVenue, type TradingVenueInput } from "../venue.ts";

describe("formatTradingVenue", () => {
	it("shows paper market data as the configured exchange public feed", () => {
		expect(
			formatTradingVenue({
				language: "zh-CN",
				mode: "paper",
				exchangeId: "okx",
				marketType: "spot",
				quoteCurrency: "USDT",
			}),
		).toEqual({
			identity: "模拟盘  OKX  现货  USDT",
			source: "行情来源：OKX 公开接口",
		});
	});

	describe("trading venue layout", () => {
		const input: TradingVenueInput = {
			language: "en-US",
			mode: "live",
			exchangeId: "binance",
			marketType: "usdm-futures",
			quoteCurrency: "USDT",
			paused: true,
		};
		const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

		it("aligns the source to the right on wide terminals", () => {
			const lines = renderTradingVenue(input, plainTheme, 140);
			expect(lines).toHaveLength(1);
			expect(lines[0].startsWith(" [ LIVE ]  [ PAUSED ]  |  Binance")).toBe(true);
			expect(lines[0]).toMatch(/orders and market data: Binance $/);
			expect(visibleWidth(lines[0])).toBe(140);
		});

		it("keeps the pause next to the mode and moves the source to its own line", () => {
			const lines = renderTradingVenue(input, plainTheme, 80).map((line) => line.trim());
			expect(lines).toEqual([
				"[ LIVE ]  [ PAUSED ]  |  Binance  |  USDⓈ-M futures  USDT",
				"orders and market data: Binance",
			]);
		});

		it.each(["en-US", "zh-CN"] as const)("preserves venue information when wrapping %s", (language) => {
			const lines = renderTradingVenue({ ...input, language }, plainTheme, 32);
			const text = lines.join("\n");
			expect(text).toContain(language === "zh-CN" ? "[ 已暂停 ]" : "[ PAUSED ]");
			expect(text).toContain("Binance");
			expect(text).toContain("USDⓈ-M");
			expect(text).toContain("USDT");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(32);
		});

		it("keeps the paper feed distinct from live execution", () => {
			const text = renderTradingVenue({ ...input, mode: "paper", paused: false }, plainTheme, 100).join("\n");
			expect(text).toContain("[ PAPER ]");
			expect(text).toContain("market data: Binance public");
			expect(text).not.toContain("PAUSED");
			expect(text).not.toContain("orders and market data");
		});

		it.each(["confirm", "unattended"] as const)("keeps live approval %s visible when wrapping", (orderApproval) => {
			const text = renderTradingVenue({ ...input, orderApproval }, plainTheme, 40)
				.join(" ")
				.replace(/\s+/g, " ");
			expect(text).toContain(orderApproval === "confirm" ? "Confirm each order" : "Unattended");
			expect(text).toContain("PAUSED");
			expect(formatTradingVenue({ ...input, orderApproval }).identity).toContain(
				orderApproval === "confirm" ? "Confirm each order" : "Unattended",
			);
		});

		it.each(["light", "dark"])("uses semantic colors in the %s theme without overflowing", (name) => {
			const theme = getThemeByName(name);
			if (!theme) throw new Error(`Missing theme: ${name}`);
			const wide = renderTradingVenue(input, theme, 140).join("\n");
			expect(wide).toContain(theme.bold(theme.fg("error", "[ LIVE ]")));
			expect(wide).toContain(theme.bold(theme.fg("warning", "[ PAUSED ]")));
			expect(wide).toContain(theme.fg("text", "Binance"));
			for (const width of [1, 2, 20, 40, 80, 140]) {
				for (const line of renderTradingVenue({ ...input, language: "zh-CN" }, theme, width)) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					expect(stripVTControlCharacters(line)).not.toContain("\x1b");
				}
			}
			expect(renderTradingVenue(input, theme, 0)).toEqual([]);
		});

		it("fits routine identity, source and health into two rows at 80 columns", () => {
			const lines = renderTradingVenue(
				{ ...input, mode: "paper", exchangeId: "okx", marketType: "spot", paused: false },
				plainTheme,
				80,
				{
					summary: "Entry blocks: none",
					observations: "Monitor: disabled  /health",
					tone: "muted",
					entryBlocked: false,
				},
			);
			expect(lines).toHaveLength(2);
			expect(lines[0]).toContain("[ PAPER ]");
			expect(lines[0]).toContain("Entry blocks: none");
			expect(lines[1]).toContain("market data: OKX public");
			expect(lines[1]).toContain("Monitor: disabled");
			expect(lines.join("\n")).not.toMatch(/authorized|safe to trade/i);
		});

		it("puts blocks first and preserves live approval, observations and source at narrow widths", () => {
			const status = {
				summary: "Entry blocks: unresolved executions",
				observations: "Monitor: orders: stale, observed 6m ago, pending 2  /health",
				tone: "warning",
				entryBlocked: true,
				recoveryHint: "Inspect /recovery; do not resubmit orders.",
			} as const;
			for (const width of [20, 40, 80, 140]) {
				const lines = renderTradingVenue({ ...input, orderApproval: "confirm" }, plainTheme, width, status);
				const text = lines.join(" ").replace(/\s+/g, " ");
				expect(text.trim()).toMatch(/^Entry blocks:/);
				for (const expected of [
					"[ LIVE ]",
					"[ PAUSED ]",
					"Binance",
					"USDT",
					"Confirm each order",
					"observed 6m ago",
					"pending 2",
					"/health",
					"/recovery",
					"orders and market data: Binance",
				]) {
					expect(text).toContain(expected);
				}
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			expect(formatTradingStatus(input, status)[0]).toBe(status.summary);
		});

		it("puts degraded observations ahead of routine identity and never colors no blocks as approval", () => {
			const theme = getThemeByName("dark");
			if (!theme) throw new Error("Missing dark theme");
			const status = {
				summary: "Entry blocks: none",
				observations: "Monitor: orders: degraded, observed 30s ago  /health",
				tone: "warning",
				entryBlocked: false,
			} as const;
			const lines = renderTradingVenue({ ...input, paused: false }, theme, 100, status);
			expect(stripVTControlCharacters(lines[0])).toContain(status.observations);
			expect(lines.join("\n")).toContain(theme.fg("muted", status.summary));
			expect(formatTradingStatus(input, status)[0]).toBe(status.observations);
		});

		it("preserves localized health and venue information without overflowing", () => {
			const theme = getThemeByName("light");
			if (!theme) throw new Error("Missing light theme");
			const status = {
				summary: "开仓阻断：无",
				observations: "监控: 订单: 近期, 12 秒前观测  /health",
				tone: "muted",
				entryBlocked: false,
			} as const;
			for (const width of [1, 2, 20, 40, 80, 140]) {
				const lines = renderTradingVenue(
					{ ...input, language: "zh-CN", orderApproval: "unattended" },
					theme,
					width,
					status,
				);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				if (width >= 40) {
					const text = lines.map(stripVTControlCharacters).join(" ").replace(/\s+/g, " ");
					expect(text).toContain("12 秒前观测");
					expect(text).toContain("开仓阻断：无");
					expect(text).toContain("USDT");
					expect(text).toContain("/health");
				}
			}
		});
	});

	it("shows live orders and market data on the same exchange", () => {
		expect(
			formatTradingVenue({
				language: "en-US",
				mode: "live",
				exchangeId: "binance",
				marketType: "usdm-futures",
				quoteCurrency: "USDT",
				paused: true,
			}),
		).toEqual({
			identity: "LIVE  Binance  USDⓈ-M futures  USDT  PAUSED",
			source: "orders and market data: Binance",
		});
	});
});
