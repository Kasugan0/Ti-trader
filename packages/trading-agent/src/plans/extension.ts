import { randomUUID } from "node:crypto";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getTrading } from "../context.ts";
import { failureCode } from "../failure-code.ts";
import { t, translate } from "../i18n.ts";
import { renderTradingTable, type TableData } from "../table.ts";
import { formatPosition, jsonResult, type TradingProvider } from "../tools/format.ts";
import { observePlanAccounts } from "./account-observations.ts";
import { identifierSchema, planContentSchema } from "./model.ts";
import { deliverPlanNotifications } from "./monitoring.ts";
import { planDetailView, planListView, planOverview, planPage } from "./presentation.ts";
import { PlanMonitor, planIndex, reviewPlan } from "./runtime.ts";
import { PlanStore } from "./store.ts";

export function createPlanExtension(provider: TradingProvider = getTrading, store = new PlanStore()): ExtensionFactory {
	return (pi) => {
		const monitor = new PlanMonitor(store);
		let timer: ReturnType<typeof setInterval> | undefined;
		let generation = 0;
		let busy = false;
		let lastPoll = 0;
		let refreshedEngine: ReturnType<TradingProvider>["tradingEngine"] | undefined;
		const scope = () => provider().tradingEngine.getExecutionScope();
		pi.registerEntryRenderer<TableData>("trading:plan", (entry, _options, theme) =>
			renderTradingTable(entry.data ?? { title: "plan", lines: [] }, theme),
		);
		const show = (data: TableData) => pi.appendEntry("trading:plan", data);
		const observe = async (trading: ReturnType<TradingProvider>, isCurrent: () => boolean) => {
			const events = await monitor.tick(
				trading.tradingEngine.getExecutionScope(),
				{
					getTicker: (symbol) => trading.marketData.getTicker(symbol),
					getKlines: (symbol, timeframe, limit) => trading.marketData.getKlines(symbol, timeframe, limit),
					getPositions: () => trading.tradingEngine.getPositions(),
					getOpenOrders: () => trading.tradingEngine.getOpenOrders(),
				},
				isCurrent,
				{ executions: trading.tradingEngine, protectionCoveragePct: trading.config.monitor.protectionCoveragePct },
			);
			if (isCurrent()) refreshedEngine = trading.tradingEngine;
			return events;
		};
		const review = async (id: string) => {
			const trading = provider();
			const engine = trading.tradingEngine;
			const currentScope = engine.getExecutionScope();
			const plan = store.read(id, currentScope);
			const token = generation;
			const isCurrent = () => token === generation && provider().tradingEngine === engine;
			await observe(trading, isCurrent);
			const accounts = await observePlanAccounts(
				store,
				[store.read(id, currentScope)],
				currentScope,
				{
					getPositions: () => engine.getPositions(),
					getOpenOrders: () => engine.getOpenOrders(),
				},
				engine,
				isCurrent,
				Date.now,
				trading.config.monitor.protectionCoveragePct,
				true,
			);
			if (!isCurrent()) throw new Error("Trading runtime changed; request a fresh review");
			const account = accounts.get(plan.id);
			return {
				review: reviewPlan(store.read(id, currentScope)),
				currentPositions: account?.positions?.map(formatPosition) ?? null,
				limitations: account?.observation.limitations ?? ["Current account observations unavailable"],
			};
		};
		pi.registerTool({
			name: "list_plans",
			label: "list_plans",
			description: "List saved plans for this account; notes are not current account facts.",
			parameters: Type.Object({
				offset: Type.Optional(Type.Integer({ minimum: 0 })),
				archived: Type.Optional(Type.Boolean()),
			}),
			async execute(_id, params) {
				const plans = store.list(scope()).filter((plan) => params.archived || plan.status !== "archived");
				const offset = params.offset ?? 0;
				return jsonResult({
					total: plans.length,
					nextOffset: offset + 20 < plans.length ? offset + 20 : null,
					plans: plans.slice(offset, offset + 20).map((plan) => ({
						id: plan.id,
						revision: plan.revision,
						activeVersion: plan.activeVersion,
						latestVersion: plan.versions.length,
						status: plan.status,
						symbol: plan.versions.at(-1)!.content.symbol,
						updatedAt: plan.versions.at(-1)!.at,
					})),
				});
			},
		});
		pi.registerTool({
			name: "read_plan",
			label: "read_plan",
			description:
				"Read a bounded overview or page of immutable versions, notes, events, intents or executions; continue with nextOffset. Recheck current account facts before acting.",
			parameters: Type.Object({
				id: identifierSchema,
				section: Type.Optional(
					Type.Union([
						Type.Literal("overview"),
						Type.Literal("versions"),
						Type.Literal("notes"),
						Type.Literal("events"),
						Type.Literal("intents"),
						Type.Literal("executions"),
					]),
				),
				offset: Type.Optional(Type.Integer({ minimum: 0 })),
			}),
			async execute(_id, params) {
				const plan = store.read(params.id, scope());
				return jsonResult(
					!params.section || params.section === "overview"
						? planOverview(plan)
						: planPage<unknown>(plan[params.section], params.offset),
				);
			},
		});
		pi.registerTool({
			name: "create_plan",
			label: "create_plan",
			description:
				"Save a research draft, not an order. entry conditions are AND; invalidation conditions are OR. Price and closed_price use this plan's symbol/timeframe. User must enable tracking with /plan track.",
			parameters: planContentSchema,
			async execute(_id, params) {
				return jsonResult(planOverview(store.create(scope(), params)));
			},
		});
		pi.registerTool({
			name: "revise_plan",
			label: "revise_plan",
			description:
				"Append a new draft version using the current revision; never rewrite the original rationale. The user must activate the new version.",
			parameters: Type.Object({
				id: identifierSchema,
				expectedRevision: Type.Integer({ minimum: 1 }),
				content: planContentSchema,
			}),
			async execute(_id, params) {
				const plan = store.revise(params.id, scope(), params.expectedRevision, params.content);
				return jsonResult({
					id: plan.id,
					revision: plan.revision,
					activeVersion: plan.activeVersion,
					version: plan.versions.at(-1),
				});
			},
		});
		pi.registerTool({
			name: "append_plan_note",
			label: "append_plan_note",
			description: "Append model-authored research, not execution evidence or authorization.",
			parameters: Type.Object({ id: identifierSchema, text: Type.String({ minLength: 1, maxLength: 4096 }) }),
			async execute(_id, params) {
				store.note(params.id, scope(), params.text);
				return jsonResult({ status: "saved" });
			},
		});
		pi.registerTool({
			name: "get_plan_review",
			label: "get_plan_review",
			description:
				"Refresh the summary using bounded correlated reads. Other sections page stored differences, executions, events or gaps with nextOffset; refresh summary first when needed. Never submits, cancels or approves an order.",
			parameters: Type.Object({
				id: identifierSchema,
				section: Type.Optional(
					Type.Union([
						Type.Literal("summary"),
						Type.Literal("differences"),
						Type.Literal("executions"),
						Type.Literal("events"),
						Type.Literal("gaps"),
					]),
				),
				offset: Type.Optional(Type.Integer({ minimum: 0 })),
			}),
			async execute(_id, params) {
				if (params.section && params.section !== "summary") {
					const snapshot = reviewPlan(store.read(params.id, scope()));
					return jsonResult(
						planPage<unknown>(
							params.section === "gaps" ? snapshot.result.gaps : snapshot[params.section],
							params.offset,
						),
					);
				}
				const result = await review(params.id);
				return jsonResult({
					...planOverview(store.read(params.id, scope())),
					result: {
						...result.review.result,
						gaps: result.review.result.gaps.slice(0, 20),
						totalGaps: result.review.result.gaps.length,
					},
					currentPositions: result.currentPositions,
					limitations: result.limitations,
					observationFresh: result.review.observationFresh,
					accountObservationFresh: result.review.accountObservationFresh,
				});
			},
		});
		pi.registerCommand("plan", {
			description: t(provider().config.language, "cmdPlan"),
			getArgumentCompletions: (prefix) =>
				["list", "show", "track", "archive", "review", "export", "delete"]
					.filter((value) => value.startsWith(prefix))
					.map((value) => ({ value, label: value })),
			async handler(args, ctx) {
				const [action, id, pageArgument, extra] = args.trim().split(/\s+/);
				const trading = provider();
				const engine = trading.tradingEngine;
				const currentScope = engine.getExecutionScope();
				const language = trading.config.language;
				try {
					if (!action || action === "list") {
						if (pageArgument || extra || (id && !/^[1-9]\d*$/.test(id))) throw new Error("Invalid list page");
						show(planListView(store.list(currentScope), language, id ? Number(id) : 1));
						return;
					}
					if (
						!id ||
						extra ||
						!["show", "track", "archive", "review", "export", "delete"].includes(action) ||
						(pageArgument && (!["show", "review"].includes(action) || !/^[1-9]\d*$/.test(pageArgument)))
					) {
						ctx.ui.notify(t(language, "planUsage"), "warning");
						return;
					}
					if (action === "show" || action === "review") {
						if (action === "review" && (!pageArgument || pageArgument === "1")) await review(id);
						show(
							planDetailView(
								store.read(id, currentScope),
								language,
								Number(pageArgument ?? 1),
								action === "review",
							),
						);
						return;
					}
					if (!ctx.hasUI) {
						ctx.ui.notify(t(language, "planNeedsUi"), "warning");
						return;
					}
					await ctx.waitForIdle();
					const plan = store.read(id, currentScope);
					const outstanding = engine
						.listExecutions()
						.filter(
							(record) =>
								record.reference?.kind === "trade-plan" &&
								record.reference.id === id &&
								(["prepared", "submission-started", "unknown"].includes(record.status) ||
									record.evidence?.orders.some(
										(order) => order.status === "open" || order.status === "unknown",
									)),
						);
					const confirm = await ctx.ui.confirm(
						t(language, "planConfirmTitle"),
						`${action}: ${id} v${plan.versions.length}\n${JSON.stringify(plan.versions.at(-1)!.content, null, 2)}\n` +
							`${translate(language, "planExposureWarning", { count: outstanding.length })}\n` +
							outstanding
								.slice(0, 20)
								.map((record) => `${record.id}: ${record.status}`)
								.join("\n") +
							`\n${t(language, "planResearchOnly")}`,
					);
					if (!confirm) return;
					if (
						provider().tradingEngine !== engine ||
						engine.getExecutionStatus().staleRuntime ||
						engine.getExecutionStatus().maintenance
					)
						throw new Error("Trading runtime changed or account maintenance is active");
					if (action === "track") store.activate(id, currentScope, plan.revision);
					else if (action === "archive") store.archive(id, currentScope, plan.revision);
					else if (action === "delete") store.remove(id, currentScope, plan.revision);
					else {
						const path = store.storage.export(`plan-${id}-${randomUUID()}`, plan);
						ctx.ui.notify(path, "info");
					}
					ctx.ui.notify(t(language, "planOperationDone"), "info");
				} catch (error) {
					ctx.ui.notify(translate(language, "planOperationFailed", { code: failureCode(error) }), "error");
				}
			},
		});
		pi.on("before_agent_start", () => {
			let content: string;
			try {
				const trading = provider();
				content = planIndex(
					store,
					trading.tradingEngine.getExecutionScope(),
					Date.now(),
					refreshedEngine !== trading.tradingEngine,
				);
			} catch (error) {
				content = translate(provider().config.language, "planContextUnavailable", { code: failureCode(error) });
				console.error(`[plans] ${content}`);
			}
			return { message: { customType: "trade-plan-context", content, display: false } };
		});
		const poll = async (ctx: ExtensionContext, token: number) => {
			if (busy || token !== generation) return;
			const trading = provider();
			if (!trading.config.monitor.enabled || Date.now() - lastPoll < trading.config.monitor.intervalSec * 1000)
				return;
			busy = true;
			lastPoll = Date.now();
			const engine = trading.tradingEngine;
			try {
				const isCurrent = () =>
					token === generation && provider().tradingEngine === engine && provider().config.monitor.enabled;
				await observe(trading, isCurrent);
				const report = deliverPlanNotifications(
					store,
					engine.getExecutionScope(),
					(event) => {
						pi.sendMessage(
							{
								customType: "trade-plan-observation",
								content: `${translate(trading.config.language, "planNotification", {
									id: event.planReference!.id,
									version: event.planReference!.version,
								})}\n${event.content}`,
								details: { eventId: event.id, planEventId: event.planReference!.eventId },
								display: true,
							},
							{ triggerTurn: false },
						);
						return true;
					},
					isCurrent,
				);
				if (report.failures.length > 0 && ctx.hasUI)
					ctx.ui.notify(
						translate(trading.config.language, "planMonitoringUnavailable", {
							code: "notification-delivery-failed",
						}),
						"warning",
					);
			} catch (error) {
				const message = translate(trading.config.language, "planMonitoringUnavailable", {
					code: failureCode(error),
				});
				console.error(message);
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
			} finally {
				busy = false;
			}
		};
		pi.on("session_start", (_event, ctx) => {
			generation++;
			lastPoll = 0;
			refreshedEngine = undefined;
			monitor.resetBaseline();
			if (timer) clearInterval(timer);
			if (ctx.mode === "print" || ctx.mode === "json") return;
			const token = generation;
			timer = setInterval(() => void poll(ctx, token), 5000);
			timer.unref();
		});
		pi.on("session_shutdown", () => {
			generation++;
			if (timer) clearInterval(timer);
			timer = undefined;
		});
	};
}
