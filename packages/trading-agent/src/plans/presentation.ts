import { stripVTControlCharacters } from "node:util";
import { type MenuKey, t, translate } from "../i18n.ts";
import type { TradingLanguage } from "../state.ts";
import type { TableData } from "../table.ts";
import type { TradePlan } from "./model.ts";
import { reviewPlan } from "./runtime.ts";

const labels: Record<string, MenuKey> = {
	draft: "planDraft",
	tracking: "planTracking",
	archived: "planArchived",
	unknown: "planUnknown",
	true: "planTrue",
	false: "planFalse",
	protected: "planProtected",
	partial: "planPartial",
	none: "planUnprotected",
	"no-position": "planNoPosition",
};

export function planPage<T>(items: T[], offset = 0, exportCommand = "/plan export") {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid plan page offset");
	const page: T[] = [];
	const oversizedRecords: number[] = [];
	let nextOffset = offset;
	let bytes = 0;
	while (nextOffset < items.length && nextOffset < offset + 20) {
		const item = items[nextOffset];
		const size = Buffer.byteLength(JSON.stringify(item), "utf8");
		if (size > 16_384) {
			oversizedRecords.push(nextOffset++);
			continue;
		}
		if (bytes + size > 16_384) break;
		page.push(item);
		bytes += size;
		nextOffset++;
	}
	return {
		total: items.length,
		offset,
		nextOffset: nextOffset < items.length ? nextOffset : null,
		items: page,
		oversizedRecords,
		...(oversizedRecords.length
			? { notice: `Oversized records omitted; use the private ${exportCommand} for complete evidence.` }
			: {}),
	};
}

export function planOverview(plan: TradePlan) {
	return {
		id: plan.id,
		authority: "model-authored-research; never execution evidence or authorization",
		scope: plan.scope,
		revision: plan.revision,
		status: plan.status,
		activeVersion: plan.activeVersion,
		latestVersion: plan.versions.length,
		originalRationale: plan.versions[0].content.thesis,
		version: plan.versions[(plan.activeVersion ?? plan.versions.length) - 1],
		observation: plan.observation ?? null,
		accountObservation: plan.accountObservation
			? {
					...plan.accountObservation,
					totalOrders: plan.accountObservation.orders.length,
					orders: plan.accountObservation.orders.slice(0, 20),
				}
			: null,
		counts: {
			versions: plan.versions.length,
			notes: plan.notes.length,
			events: plan.events.length,
			intents: plan.intents.length,
			executions: plan.executions.length,
		},
	};
}

export function planListView(plans: TradePlan[], language: TradingLanguage, page = 1): TableData {
	const pages = Math.max(1, Math.ceil(plans.length / 20));
	if (!Number.isSafeInteger(page) || page < 1 || page > pages) throw new Error("Invalid plan page");
	return {
		title: t(language, "planTitle"),
		lines: [
			...plans
				.slice((page - 1) * 20, page * 20)
				.map(
					(plan) =>
						`${plan.id}  ${plan.versions[0].content.symbol}  ${t(language, labels[plan.status])}  v${plan.activeVersion ?? "-"} / ${plan.versions.length}`,
				),
			...(plans.length ? [] : [t(language, "planEmpty")]),
			translate(language, "planPage", { page, pages }),
		],
		warning: t(language, "planNotAuthority"),
	};
}

export function planDetailView(plan: TradePlan, language: TradingLanguage, page = 1, reviewing = false): TableData {
	const content = plan.versions[(plan.activeVersion ?? plan.versions.length) - 1].content;
	const review = reviewPlan(plan);
	const label = (value: string) => (labels[value] ? t(language, labels[value]) : value);
	const lines = [
		`${plan.id}  ${content.symbol}  ${label(plan.status)}`,
		`${t(language, "planRevision")}: ${plan.revision}; ${t(language, "planActiveVersion")}: ${plan.activeVersion ?? "-"}; ${t(language, "planLatestVersion")}: ${plan.versions.length}`,
		`${t(language, "planThesis")} v1: ${plan.versions[0].content.thesis}`,
		`${t(language, "planThesis")} v${plan.activeVersion ?? plan.versions.length}: ${content.thesis}`,
		`${t(language, "risk")}: ${content.risk}`,
		...(content.proposedSizeNotes
			? [`${t(language, "planProposed")} (${t(language, "colAmount")}): ${content.proposedSizeNotes}`]
			: []),
		...(content.proposedStopNotes
			? [`${t(language, "planProposed")} (${t(language, "orderReviewStopLoss")}): ${content.proposedStopNotes}`]
			: []),
		`${t(language, "planEntry")}: ${JSON.stringify(content.entry)}`,
		`${t(language, "planInvalidation")}: ${JSON.stringify(content.invalidation)}`,
		`${t(language, "planExpires")}: ${content.expiresAt}; ${t(language, "planReviewDue")}: ${content.reviewAt}`,
		`${t(language, "planObserved")}: ${plan.observation?.at ?? "-"}; ${t(language, review.observationFresh ? "healthRecent" : "healthStale")}`,
		`${t(language, "planEntry")}: ${label(plan.observation?.entry ?? "unknown")}; ${t(language, "planInvalidation")}: ${label(plan.observation?.invalidation ?? "unknown")}`,
		`${t(language, "planProtection")}: ${label(plan.accountObservation?.protection ?? "unknown")}; ${t(language, review.accountObservationFresh ? "healthRecent" : "healthStale")}`,
		...content.evidence.map(
			(evidence) =>
				`${t(language, "planEvidence")}: ${evidence.observedAt} ${evidence.source}${evidence.reference ? ` (${evidence.reference})` : ""}: ${evidence.summary}`,
		),
		...(reviewing
			? [
					`${t(language, "planCashFlow")}: ${review.result.netQuoteCashFlow ?? t(language, "planIncomplete")} ${plan.scope.quoteCurrency}`,
					...review.result.gaps.map((gap) => `${t(language, "planGaps")}: ${gap}`),
					...review.differences.flatMap((comparison) => [
						`${t(language, "planDifferences")}: ${comparison.intentId} v${comparison.version}`,
						`${t(language, "planProposed")}: ${JSON.stringify(comparison.proposed)}`,
						...comparison.actual.map((actual) => `${t(language, "planActual")}: ${JSON.stringify(actual)}`),
						...comparison.gaps.map((gap) => `${t(language, "planGaps")}: ${gap}`),
					]),
				]
			: []),
		...(plan.accountObservation?.limitations.map((gap) => `${t(language, "planGaps")}: ${gap}`) ?? []),
		...plan.versions.map(
			(version) => `${t(language, "planHistory")}: v${version.version} ${version.at} ${version.content.thesis}`,
		),
		...plan.events.map(
			(event) => `${t(language, "planHistory")}: ${event.at} v${event.version} ${event.kind} ${event.detail}`,
		),
		...plan.notes.map((note) => `${t(language, "planNotes")}: ${note.at} ${note.author}: ${note.text}`),
	];
	const pages = Math.max(1, Math.ceil(lines.length / 16));
	if (!Number.isSafeInteger(page) || page < 1 || page > pages) throw new Error("Invalid plan page");
	return {
		title: t(language, "planTitle"),
		lines: [
			...lines
				.slice((page - 1) * 16, page * 16)
				.map((line) => stripVTControlCharacters(line).replaceAll("\r", ""))
				.map((line) => (line.length > 1200 ? `${line.slice(0, 1200)}... [/plan export]` : line)),
			translate(language, "planPage", { page, pages }),
		],
		warning: t(language, "planNotAuthority"),
	};
}
