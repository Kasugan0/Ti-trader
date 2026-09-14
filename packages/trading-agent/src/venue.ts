import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { exchangeLabel } from "./exchanges.ts";
import { orderApprovalLabel, t, translate } from "./i18n.ts";
import type { MarketType, OrderApprovalMode, TradingLanguage, TradingMode } from "./state.ts";

export interface TradingVenueDisplay {
	/** Compact identity for the footer status line. */
	identity: string;
	/** Where prices and books come from; paper fills are local. */
	source: string;
}

export interface TradingVenueInput {
	language: TradingLanguage;
	mode: TradingMode;
	exchangeId: string;
	marketType: MarketType;
	quoteCurrency: string;
	paused?: boolean;
	orderApproval?: OrderApprovalMode;
}

export interface TradingVenueStatus {
	summary: string;
	observations?: string;
	tone: "muted" | "warning" | "error";
	entryBlocked: boolean;
	recoveryHint?: string;
}

function marketLabel(language: TradingLanguage, marketType: MarketType): string {
	if (marketType === "spot") return t(language, "marketSpot");
	if (marketType === "usdm-futures") return t(language, "marketFutures");
	return t(language, "marketBoth");
}

export function formatTradingVenue(input: TradingVenueInput): TradingVenueDisplay {
	const exchange = exchangeLabel(input.exchangeId, input.language);
	const paused = input.paused ? `  ${t(input.language, "riskEntriesPaused")}` : "";
	const approval =
		input.mode === "live" && input.orderApproval
			? `  ${orderApprovalLabel(input.language, input.orderApproval)}`
			: "";
	const identity = `${t(input.language, input.mode === "live" ? "venueLive" : "venuePaper")}  ${exchange}  ${marketLabel(input.language, input.marketType)}  ${input.quoteCurrency}${paused}${approval}`;
	const source = translate(input.language, input.mode === "live" ? "venueLiveSource" : "venuePaperSource", {
		exchange,
	});
	return { identity, source };
}

export function renderTradingVenue(
	input: TradingVenueInput,
	theme: Pick<Theme, "fg" | "bold">,
	width: number,
	status?: TradingVenueStatus,
): string[] {
	if (width <= 0) return [];
	const mode = t(input.language, input.mode === "live" ? "venueLive" : "venuePaper");
	const badge = theme.bold(theme.fg(input.mode === "live" ? "error" : "accent", `[ ${mode} ]`));
	const pause = input.paused
		? `  ${theme.bold(theme.fg("warning", `[ ${t(input.language, "riskEntriesPaused")} ]`))}`
		: "";
	const separator = theme.fg("dim", "  |  ");
	const identity =
		badge +
		pause +
		separator +
		theme.fg("text", exchangeLabel(input.exchangeId, input.language)) +
		separator +
		theme.fg("muted", `${marketLabel(input.language, input.marketType)}  ${input.quoteCurrency}`) +
		(input.mode === "live" && input.orderApproval
			? separator +
				theme.fg(
					input.orderApproval === "unattended" ? "warning" : "muted",
					orderApprovalLabel(input.language, input.orderApproval),
				)
			: "");
	const source = theme.fg("muted", formatTradingVenue(input).source);
	if (status) {
		const pair = (left: string, right: string): string => {
			const gap = width - 2 - visibleWidth(left) - visibleWidth(right);
			return gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : `${left}\n${right}`;
		};
		const blocked = status.entryBlocked || status.tone === "error";
		const summary = theme.fg(blocked ? status.tone : "muted", status.summary);
		const observations = status.observations && theme.fg(status.tone, status.observations);
		const content = [
			...(blocked ? [summary] : []),
			...(!blocked && status.tone === "warning" && observations ? [observations] : []),
			blocked ? pair(identity, source) : pair(identity, summary),
			...(blocked
				? observations
					? [observations]
					: []
				: [status.tone === "muted" && observations ? pair(source, observations) : source]),
			...(status.recoveryHint ? [theme.fg("warning", status.recoveryHint)] : []),
		].join("\n");
		return new Text(content, 1, 0).render(width).map((line) => truncateToWidth(line, width));
	}
	const gap = width - 2 - visibleWidth(identity) - visibleWidth(source);
	const content = gap >= 4 ? `${identity}${" ".repeat(gap)}${source}` : `${identity}\n${source}`;
	return new Text(content, 1, 0).render(width).map((line) => truncateToWidth(line, width));
}

export function formatTradingStatus(input: TradingVenueInput, status: TradingVenueStatus): string[] {
	const venue = formatTradingVenue(input);
	const priority = status.entryBlocked || status.tone === "error";
	return [
		...(priority ? [status.summary] : []),
		...(!priority && status.tone === "warning" && status.observations ? [status.observations] : []),
		`${venue.identity}  ${priority ? venue.source : status.summary}`,
		...(priority
			? status.observations
				? [status.observations]
				: []
			: [status.tone === "muted" && status.observations ? `${venue.source}  ${status.observations}` : venue.source]),
		...(status.recoveryHint ? [status.recoveryHint] : []),
	];
}
