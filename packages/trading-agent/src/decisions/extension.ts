import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ExecutionRecord } from "@nikopack/ti-trading-engine";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { getTrading } from "../context.ts";
import { failureCode } from "../failure-code.ts";
import { t, translate } from "../i18n.ts";
import { canonicalTime, sameScope } from "../plans/model.ts";
import { planPage } from "../plans/presentation.ts";
import { PlanStore } from "../plans/store.ts";
import { renderTradingTable, type TableData } from "../table.ts";
import { jsonResult, type TradingProvider } from "../tools/format.ts";
import { DecisionOutcomeCollector } from "./collector.ts";
import { evaluateActualExecutions } from "./evaluation.ts";
import { DecisionStore, decisionSchema, evaluateDecisions, evidenceFingerprint } from "./evidence.ts";
import { decisionEvaluationPage, decisionTurnPage, evaluationSectionSchema } from "./presentation.ts";
import { validateStudyConfig } from "./protocol.ts";

const mutations = new Set([
	"buy",
	"sell",
	"place_oco",
	"cancel_order",
	"cancel_order_list",
	"set_leverage",
	"set_margin_mode",
	"set_multi_assets_mode",
]);
const observations = new Set([
	"get_price",
	"get_order_book",
	"get_klines",
	"get_balance",
	"get_positions",
	"get_open_orders",
	"get_portfolio_snapshot",
	"get_risk_status",
	"get_market_info",
	"get_contract_stats",
	"check_order",
]);
function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function safeSymbol(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Z0-9_-]+\/[A-Z0-9_-]+(?::[A-Z0-9_-]+)?$/.test(value) ? value : undefined;
}

export function createDecisionEvidenceExtension(
	provider: TradingProvider = getTrading,
	store = new DecisionStore(),
	version = "working-tree",
): ExtensionFactory {
	return (pi) => {
		let turnId: string | undefined;
		let captureComplete = true;
		let capturedScope: ReturnType<ReturnType<TradingProvider>["getExecutionScope"]> | undefined;
		let capturedEpoch: number | undefined;
		let activeTools: string[] = [];
		let timer: ReturnType<typeof setInterval> | undefined;
		const planStore = new PlanStore(dirname(dirname(store.storage.path)));
		const collector = new DecisionOutcomeCollector(store, () => ({
			getExecutionScope: () => provider().tradingEngine.getExecutionScope(),
			getEpoch: () => planStore.epoch(provider().tradingEngine.getExecutionScope()),
			marketData: provider().marketData,
		}));
		const owners = new Map<string, { turnId: string; entryId: string }>();
		pi.registerEntryRenderer<TableData>("trading:decisions", (entry, _options, theme) =>
			renderTradingTable(entry.data ?? { title: "decisions", lines: [] }, theme),
		);
		const show = (value: unknown) =>
			pi.appendEntry<TableData>("trading:decisions", {
				title: t(provider().config.language, "decisionTitle"),
				lines: JSON.stringify(value, null, 2).split("\n"),
				warning: t(provider().config.language, "decisionNotAuthority"),
			});
		const report = (error: unknown, ctx: ExtensionContext) => {
			captureComplete = false;
			const message = translate(provider().config.language, "decisionUnavailable", { code: failureCode(error) });
			console.error(`[decisions] ${message}`);
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
		};
		const currentId = () => {
			if (
				!turnId ||
				!capturedScope ||
				!sameScope(capturedScope, provider().tradingEngine.getExecutionScope()) ||
				capturedEpoch !== planStore.epoch(capturedScope)
			)
				throw new Error("No active decision turn for this account");
			return turnId;
		};
		const evaluation = () => {
			const runtime = provider();
			const scope = runtime.tradingEngine.getExecutionScope();
			const evidence = store.evidence(scope);
			const records = new Map<string, ExecutionRecord>();
			for (const record of [
				...planStore.list(scope).flatMap((plan) => plan.executions.map((entry) => entry.record)),
				...runtime.tradingEngine.listExecutions(),
			]) {
				if (sameScope(record.scope, scope) && (records.get(record.id)?.revision ?? 0) <= record.revision)
					records.set(record.id, record);
			}
			const now = Date.now();
			return {
				...evaluateDecisions(evidence, now),
				actualExecution: evaluateActualExecutions(evidence, [...records.values()], now),
				evaluatedAt: new Date(now).toISOString(),
				evidence,
				executionRecords: [...records.values()],
			};
		};
		const collect = async (ctx: ExtensionContext) => {
			const result = await collector.collect();
			if (result.issues.length) {
				const message = translate(provider().config.language, "decisionObservationIncomplete", {
					issues: result.issues.join(", "),
				});
				console.error(`[decisions] ${message}`);
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
			}
			return result;
		};
		pi.on("session_start", async (_event, ctx) => {
			if (timer) clearInterval(timer);
			collector.start();
			try {
				await collect(ctx);
			} catch (error) {
				report(error, ctx);
			}
			timer = setInterval(() => {
				void collect(ctx).catch((error: unknown) => report(error, ctx));
			}, 5000);
			timer.unref();
		});
		pi.on("before_agent_start", (event, ctx) => {
			try {
				if (turnId) store.finish(turnId, "interrupted", captureComplete);
				turnId = undefined;
				captureComplete = true;
				capturedScope = provider().tradingEngine.getExecutionScope();
				capturedEpoch = planStore.epoch(capturedScope);
				activeTools = [...pi.getActiveTools()].sort();
				const allTools = pi.getAllTools();
				const tools = activeTools.map((name) => {
					const tool = allTools.find((entry) => entry.name === name);
					return {
						name,
						parameters: tool?.parameters ?? null,
						description: tool?.description ?? null,
						promptGuidelines: tool?.promptGuidelines ?? null,
					};
				});
				turnId = store.start(
					capturedScope,
					ctx.model?.provider ?? "unavailable",
					ctx.model?.id ?? "unavailable",
					evidenceFingerprint(event.systemPrompt, tools, version),
					tools.every((tool) => tool.parameters !== null),
					capturedEpoch,
				);
			} catch (error) {
				turnId = undefined;
				report(error, ctx);
			}
		});
		pi.on("tool_call", (event, ctx) => {
			if (!mutations.has(event.toolName) && !observations.has(event.toolName)) return;
			try {
				const id = currentId();
				if (JSON.stringify([...pi.getActiveTools()].sort()) !== JSON.stringify(activeTools))
					captureComplete = false;
				const entryId = randomUUID();
				owners.set(event.toolCallId, { turnId: id, entryId });
				if (mutations.has(event.toolName))
					store.update(id, (turn) => {
						const symbol = safeSymbol(object(event.input).symbol);
						turn.mutations.push({
							id: entryId,
							tool: event.toolName,
							at: new Date().toISOString(),
							...(symbol ? { symbol } : {}),
							decisionIds: turn.claims.map((claim) => claim.id),
							outcome: "pending",
						});
					});
			} catch (error) {
				report(error, ctx);
			}
		});
		pi.on("tool_result", (event, ctx) => {
			const owner = owners.get(event.toolCallId);
			if (!owner) return;
			owners.delete(event.toolCallId);
			try {
				const details = object(event.details);
				if (mutations.has(event.toolName)) {
					store.update(owner.turnId, (turn) => {
						const mutation = turn.mutations.find((entry) => entry.id === owner.entryId);
						if (!mutation) throw new Error("Mutation evidence missing");
						const diagnostic = event.content
							.filter((content) => content.type === "text")
							.map((content) => content.text)
							.join("\n");
						mutation.outcome = event.isError
							? /unknown|recovery/i.test(diagnostic)
								? "unknown"
								: /risk|blocked|limit|permission|confirmation/i.test(diagnostic)
									? "blocked"
									: "error"
							: details.status === "cancelled"
								? "cancelled"
								: details.status === "rejected"
									? "blocked"
									: details.status === "unknown"
										? "unknown"
										: "request-completed";
						if (typeof details.executionId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(details.executionId))
							mutation.executionId = details.executionId;
					});
					return;
				}
				const id = randomUUID();
				const at = new Date().toISOString();
				const rawTime = details.time ?? details.asOf ?? details.timestamp;
				const sourceTime =
					typeof rawTime === "string" && canonicalTime(rawTime)
						? Date.parse(rawTime)
						: typeof rawTime === "number" && Number.isSafeInteger(rawTime) && rawTime >= 0 && rawTime <= 8.64e15
							? rawTime
							: Number.NaN;
				const snapshot: Record<string, number | null> = {};
				for (const key of [
					"last",
					"bid",
					"ask",
					"spread",
					"spreadPct",
					"totalQuoteValue",
					"knownValuedQuote",
					"count",
					"markPrice",
					"indexPrice",
					"fundingRate",
					"openInterest",
				])
					if (details[key] === null || (typeof details[key] === "number" && Number.isFinite(details[key])))
						snapshot[key] = details[key] as number | null;
				const account = object(details.account);
				for (const key of ["estimatedEquity", "grossExposure", "unrealizedPnl", "openOrderNotional"])
					if (account[key] === null || (typeof account[key] === "number" && Number.isFinite(account[key])))
						snapshot[key] = account[key] as number | null;
				const symbol = safeSymbol(event.input.symbol);
				store.update(owner.turnId, (turn) => {
					const sourceMismatch =
						!sameScope(turn.scope, provider().tradingEngine.getExecutionScope()) ||
						(turn.epoch ?? 0) !== planStore.epoch(turn.scope) ||
						(details.exchange !== undefined && details.exchange !== turn.scope.exchange) ||
						(details.mode !== undefined && details.mode !== turn.scope.mode) ||
						(details.symbol !== undefined && details.symbol !== symbol) ||
						(details.scope !== undefined && !sameScope(turn.scope, object(details.scope) as typeof turn.scope));
					turn.observations.push({
						id,
						tool: event.toolName,
						at,
						sourceAt: Number.isFinite(sourceTime) ? new Date(sourceTime).toISOString() : null,
						sourceTimeVerified:
							event.toolName === "get_price" ? details.sourceTimestampKnown === true : undefined,
						scope: structuredClone(turn.scope),
						...(symbol ? { symbol } : {}),
						status: event.isError
							? "error"
							: sourceMismatch ||
									!Number.isFinite(sourceTime) ||
									sourceTime > Date.parse(at) ||
									(Array.isArray(details.warnings) && details.warnings.length > 0) ||
									details.status === "unknown" ||
									details.status === "rejected"
								? "partial"
								: "observed",
						snapshot,
						digest: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
					});
				});
				return {
					content: [
						...event.content,
						{
							type: "text" as const,
							text: `Decision observation ID: ${id} (bounded numeric snapshot; missing source timestamps remain unknown).`,
						},
					],
				};
			} catch (error) {
				report(error, ctx);
			}
		});
		pi.registerTool({
			name: "record_decision",
			label: "record_decision",
			description:
				"Record a concise public rationale BEFORE trading, or record wait/hold/avoid. Cite observation IDs returned by trading tools. Optional forecast.direction is a public up/down/flat claim, never inferred from prose. An operator's frozen numeric study horizon, not your free-text horizon, controls evaluation. This does not approve or place orders.",
			parameters: decisionSchema,
			async execute(_id, params) {
				const turn = currentId();
				const id = store.record(turn, params);
				const enrollment = store
					.list(provider().tradingEngine.getExecutionScope())
					.find((entry) => entry.id === turn)
					?.claims.find((entry) => entry.id === id)?.evaluation;
				return jsonResult({ id, status: "recorded_model_claim", prospectiveEvaluation: enrollment ?? null });
			},
		});
		pi.registerTool({
			name: "get_decision_evaluation",
			label: "get_decision_evaluation",
			description:
				"Read deterministic evidence-discipline and prospective fixed-horizon study reports for this account, with frozen protocols, missing samples, declared-cost cash/buy-and-hold comparisons and separate execution-evidence gaps. Never establishes model trust, account profitability, operational readiness or trading permission.",
			parameters: Type.Object({
				section: Type.Optional(evaluationSectionSchema),
				offset: Type.Optional(Type.Integer({ minimum: 0 })),
			}),
			async execute(_id, params) {
				return jsonResult(decisionEvaluationPage(evaluation(), params.section, params.offset));
			},
		});
		pi.on("agent_end", (event, ctx) => {
			if (!turnId) return;
			try {
				const failed = event.messages.some(
					(message) =>
						message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"),
				);
				store.finish(turnId, failed ? "failed" : "finished", captureComplete);
			} catch (error) {
				report(error, ctx);
			} finally {
				turnId = undefined;
			}
		});
		pi.on("session_shutdown", (_event, ctx) => {
			if (timer) clearInterval(timer);
			timer = undefined;
			collector.stop();
			if (!turnId) return;
			try {
				store.finish(turnId, "interrupted", captureComplete);
			} catch (error) {
				report(error, ctx);
			} finally {
				turnId = undefined;
				owners.clear();
			}
		});
		pi.registerCommand("decisions", {
			description: t(provider().config.language, "cmdDecisions"),
			getArgumentCompletions: (prefix) =>
				[
					"list",
					"show",
					"evaluate",
					"evaluate strategy",
					"evaluate samples",
					"evaluate executions",
					"export",
					"delete",
					"study",
					"study create",
					"study stop",
					"collect",
				]
					.filter((value) => value.startsWith(prefix))
					.map((value) => ({ value, label: value })),
			async handler(args, ctx) {
				const language = provider().config.language;
				if (!ctx.hasUI) throw new Error(t(language, "decisionNeedsUi"));
				const studyCommand = args.trim().match(/^study(?:\s+(create|stop)(?:\s+([\s\S]+))?)?$/);
				if (studyCommand) {
					const scope = provider().tradingEngine.getExecutionScope();
					const epoch = planStore.epoch(scope);
					const [, command, input] = studyCommand;
					if (command === "create") {
						if (!input) throw new Error(t(language, "decisionStudyUsage"));
						const config: unknown = JSON.parse(input);
						validateStudyConfig(config);
						if (
							!(await ctx.ui.confirm(
								t(language, "decisionStudyConfirm"),
								`${JSON.stringify({ scope, epoch, config }, null, 2)}\n${t(language, "decisionStudyNotice")}`,
							))
						)
							return;
						if (
							!sameScope(scope, provider().tradingEngine.getExecutionScope()) ||
							epoch !== planStore.epoch(scope)
						)
							throw new Error(t(language, "decisionAccountChanged"));
						const study = store.confirmStudy(scope, config, epoch);
						show(study);
						return;
					}
					if (command === "stop") {
						if (!input || /\s/.test(input)) throw new Error(t(language, "decisionStudyUsage"));
						if (!(await ctx.ui.confirm(t(language, "decisionStopConfirm"), t(language, "decisionStopNotice"))))
							return;
						if (!sameScope(scope, provider().tradingEngine.getExecutionScope()))
							throw new Error(t(language, "decisionAccountChanged"));
						store.stopStudy(scope, input);
					}
					show(planPage(store.evidence(scope).studies ?? [], 0, "/decisions export"));
					return;
				}
				const [action, id, pageOffset, extra] = args.trim().split(/\s+/);
				const currentScope = provider().tradingEngine.getExecutionScope();
				const turns = store.list(currentScope);
				if (
					extra ||
					!["", "list", "show", "evaluate", "export", "delete", "collect"].includes(action) ||
					(pageOffset && action !== "show" && action !== "evaluate") ||
					(id && !["list", "show", "evaluate", "delete"].includes(action))
				)
					throw new Error(t(language, "decisionUsage"));
				const rawOffset = action === "list" ? id : pageOffset;
				if (rawOffset !== undefined && !/^\d+$/.test(rawOffset)) throw new Error(t(language, "decisionUsage"));
				const offset = rawOffset === undefined ? 0 : Number(rawOffset);
				if (!Number.isSafeInteger(offset)) throw new Error(t(language, "decisionUsage"));
				if (action === "collect") {
					const result = await collect(ctx);
					show(result);
					return;
				}
				if (action === "export") {
					if (!(await ctx.ui.confirm(t(language, "decisionExportConfirm"), t(language, "decisionExportNotice"))))
						return;
					if (!sameScope(currentScope, provider().tradingEngine.getExecutionScope()))
						throw new Error(t(language, "decisionAccountChanged"));
					const report = evaluation();
					ctx.ui.notify(
						store.storage.export(
							`decisions-${randomUUID()}`,
							{
								kind: "decision-study-export",
								version: 1,
								implementationVersion: version,
								evaluatedAt: report.evaluatedAt,
								evidence: report.evidence,
								executionRecords: report.executionRecords,
								evaluation: decisionEvaluationPage(report),
							},
							128 * 1024 * 1024,
						),
						"info",
					);
					return;
				}
				if (action === "delete") {
					const target = turns.find((turn) => turn.id === id);
					if (!target || target.status === "active")
						throw new Error("Cannot delete missing or active decision evidence");
					if (!(await ctx.ui.confirm(t(language, "decisionDeleteConfirm"), t(language, "decisionDeleteNotice"))))
						return;
					if (!sameScope(currentScope, provider().tradingEngine.getExecutionScope()))
						throw new Error(t(language, "decisionAccountChanged"));
					store.storage.transact((state) => {
						if (state.turns.find((turn) => turn.id === id)?.claims.some((claim) => claim.evaluation))
							throw new Error(
								"Cannot delete enrolled study evidence; deleting samples would bias the frozen protocol",
							);
						state.turns = state.turns.filter((turn) => turn.id !== id || !sameScope(turn.scope, currentScope));
					});
					ctx.ui.notify(t(language, "decisionRemoved"), "info");
					return;
				}
				if (action === "evaluate") {
					const section = id ?? "overview";
					if (!Check(evaluationSectionSchema, section)) throw new Error(t(language, "decisionUsage"));
					show(decisionEvaluationPage(evaluation(), section, offset));
				} else if (action === "show") {
					const turn = turns.find((entry) => entry.id === id);
					if (!turn) throw new Error(t(language, "decisionNotFound"));
					show(decisionTurnPage(turn, offset));
				} else {
					show(
						planPage(
							[...turns].reverse().map((turn) => ({
								id: turn.id,
								at: turn.at,
								model: turn.model,
								status: turn.status,
								decisions: turn.claims.length,
								attempts: turn.mutations.length,
							})),
							offset,
							"/decisions export",
						),
					);
				}
			},
		});
	};
}
