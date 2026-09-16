import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents, resolveChildTools } from "./agents.ts";
import { ResearchAccess } from "./bridge.ts";
import { researchRuntime } from "./protocol.ts";
import {
	runSubagent,
	type SubagentContext,
	type SubagentParams,
	type SubagentRunnerOptions,
	sessionStoreFor,
	truncateBytes,
} from "./runner.ts";
import { sessionIdSchema } from "./sessions.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const agentNameSchema = Type.String({ minLength: 1, maxLength: 64 });
const taskSchema = Type.String({ minLength: 1, maxLength: 2000 });
const TaskItem = Type.Object({
	agent: Type.Optional(agentNameSchema),
	sessionId: Type.Optional(sessionIdSchema),
	task: taskSchema,
});
const agentScopeSchema = Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")]);
const parameters = Type.Object({
	agent: Type.Optional(agentNameSchema),
	sessionId: Type.Optional(sessionIdSchema),
	task: Type.Optional(taskSchema),
	tasks: Type.Optional(Type.Array(TaskItem, { minItems: 1, maxItems: 4 })),
	chain: Type.Optional(Type.Array(TaskItem, { minItems: 1, maxItems: 8 })),
	review: Type.Optional(TaskItem),
	agentScope: Type.Optional(agentScopeSchema),
	context: Type.Optional(
		Type.Object({
			symbols: Type.Optional(Type.Array(Type.String({ minLength: 3, maxLength: 64 }), { maxItems: 8 })),
			timeframes: Type.Optional(Type.Array(Type.String({ minLength: 2, maxLength: 4 }), { maxItems: 4 })),
			constraints: Type.Optional(Type.String({ maxLength: 1000 })),
		}),
	),
});

function userAgentsDir(): string {
	const root = process.env.TI_DATA_DIR?.trim() || path.join(homedir(), ".ti-trader");
	return path.join(root, "agent", "agents");
}

export function subagentContext(ctx: ExtensionContext): SubagentContext {
	return {
		cwd: ctx.cwd,
		parentSessionId: ctx.sessionManager.getSessionId(),
		model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
		thinkingLevel: ctx.thinkingLevel,
		hasUI: ctx.hasUI,
		isProjectTrusted: () => ctx.isProjectTrusted(),
		confirm: ctx.hasUI ? (title, message) => ctx.ui.confirm(title, message) : undefined,
	};
}

function runnerOptions(signal: AbortSignal | undefined): SubagentRunnerOptions {
	return {
		bundledDir: path.join(HERE, "agents"),
		userDir: userAgentsDir(),
		extensionFileUrl: import.meta.url,
		signal: signal ?? new AbortController().signal,
	};
}

function jsonResult(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data };
}

export default function subagentExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate substantial research to persistent specialist sessions. Use subagent_agents to discover current roles and capabilities. New: agent + task. Continue: sessionId + task. Parallel: tasks[]. Chain: chain[] with {previous}. Optional review runs after the batch. Children cannot trade; proposals require the parent's controlled execution.",
		parameters,
		promptGuidelines: [
			"Delegate multi-step analysis to the appropriate specialists; keep simple price/indicator reads direct.",
			"Use subagent_agents to discover the current role catalog. Do not assume every role has all data sources.",
			"Continue the same research thread with sessionId + task. Use subagent_sessions after compaction or restart.",
			"Reports and historical proposals are not trading authorization. Refresh account facts and preview before execution.",
		],
		async execute(_id, params, signal, onUpdate, ctx) {
			const output = await runSubagent(params as SubagentParams, subagentContext(ctx), {
				...runnerOptions(signal),
				onUpdate,
			});
			if (output.isError) throw new Error(output.content[0].text);
			return output;
		},
	});
	pi.registerTool({
		name: "subagent_agents",
		label: "Research Specialists",
		description:
			"Discover effective specialist roles, models, budgets, available tools and missing services. Omitted budget fields mean unlimited. Project definitions are untrusted until explicitly confirmed.",
		parameters: Type.Object({
			agentScope: Type.Optional(agentScopeSchema),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const discovery = discoverAgents({
				cwd: ctx.cwd,
				scope: params.agentScope ?? "user",
				bundledDir: path.join(HERE, "agents"),
				userDir: userAgentsDir(),
			});
			const available = new Set(new ResearchAccess(researchRuntime()).available());
			const agents = discovery.agents.map((agent) => {
				const selected = resolveChildTools(agent.tools);
				const tools = selected.tools.filter((name) => name === "propose_order" || available.has(name));
				return {
					name: agent.name,
					description: agent.description,
					source: agent.source,
					model: agent.model ?? "inherits parent model at session creation",
					budget: agent.budget,
					tools,
					missingTools: selected.tools.filter((name) => !tools.includes(name)),
					rejectedTools: selected.rejected,
					requiresConfirmation: agent.source === "project" && !ctx.isProjectTrusted(),
				};
			});
			const offset = params.offset ?? 0;
			return jsonResult({ agents: agents.slice(offset, offset + (params.limit ?? 20)), total: agents.length });
		},
	});
	pi.registerTool({
		name: "subagent_sessions",
		label: "Research Sessions",
		description:
			"List durable child research sessions owned by this parent and account. Returns IDs and short summaries, not transcripts. Resume with subagent sessionId + task.",
		parameters: Type.Object({
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const page = sessionStoreFor(subagentContext(ctx)).list(params.limit ?? 20, params.offset ?? 0);
			return jsonResult({
				total: page.total,
				sessions: page.sessions.map((session) => ({
					sessionId: session.id,
					agent: session.agent,
					subject: truncateBytes(session.subject, 300),
					status: session.status,
					runId: session.runId,
					runCount: session.runCount,
					childPid: session.childPid,
					summary: session.summary ? truncateBytes(session.summary, 600) : undefined,
					error: session.error ? truncateBytes(session.error, 300) : undefined,
					updatedAt: session.updatedAt,
				})),
			});
		},
	});
	pi.registerTool({
		name: "subagent_evidence",
		label: "Research Evidence",
		description:
			"Read a saved child report and paged evidence index, or a bounded evidence fragment. Without evidenceId, offset/limit paginate index entries; with evidenceId, offset is a character position. Omit runId for the latest run. Reading history does not refresh timestamps.",
		parameters: Type.Object({
			sessionId: sessionIdSchema,
			runId: Type.Optional(sessionIdSchema),
			evidenceId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const run = sessionStoreFor(subagentContext(ctx)).readRun(params.sessionId, params.runId);
			const offset = params.offset ?? 0;
			const limit = params.limit ?? 20;
			if (!params.evidenceId)
				return jsonResult({
					sessionId: run.sessionId,
					runId: run.runId,
					status: run.status,
					report: run.report,
					proposals: run.proposals,
					error: run.error,
					evidence: run.evidence
						.slice(offset, offset + limit)
						.map(({ id, tool, observedAt, isError }) => ({ id, tool, observedAt, isError })),
					total: run.evidence.length,
					nextOffset: offset + limit < run.evidence.length ? offset + limit : null,
				});
			const item = run.evidence.find((item) => item.id === params.evidenceId);
			if (!item) throw new Error("Evidence not found in this owned research run");
			const serialized = JSON.stringify(item);
			if (offset > serialized.length) throw new Error("Evidence offset exceeds the saved result");
			const text = truncateBytes(serialized.slice(offset), 16 * 1024);
			return jsonResult({
				evidenceId: item.id,
				offset,
				text,
				nextOffset: offset + text.length < serialized.length ? offset + text.length : null,
				totalCharacters: serialized.length,
			});
		},
	});
}

export function registerMarketResearchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "market_research",
		label: "Market Research",
		description:
			"Read-only technical research in a persistent child session. Pass sessionId to continue, or listSessions=true to recover prior IDs. No account access or order proposals.",
		parameters: Type.Object({
			question: Type.Optional(taskSchema),
			listSessions: Type.Optional(Type.Boolean()),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
			sessionId: Type.Optional(sessionIdSchema),
			symbol: Type.Optional(Type.String({ minLength: 3, maxLength: 64 })),
			timeframe: Type.Optional(Type.String({ pattern: "^[1-9][0-9]*[mhdw]$", maxLength: 4 })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			if (params.listSessions) {
				if (params.question || params.sessionId)
					throw new Error("listSessions cannot be combined with a research task");
				const page = sessionStoreFor(subagentContext(ctx)).list(
					params.limit ?? 20,
					params.offset ?? 0,
					"technical-analyst",
				);
				return jsonResult({
					total: page.total,
					sessions: page.sessions.map((item) => ({
						sessionId: item.id,
						subject: truncateBytes(item.subject, 300),
						summary: item.summary ? truncateBytes(item.summary, 600) : undefined,
						status: item.status,
						childPid: item.childPid,
						updatedAt: item.updatedAt,
					})),
				});
			}
			if (!params.question?.trim()) throw new Error("A market research question is required");
			const output = await runSubagent(
				{
					agent: "technical-analyst",
					sessionId: params.sessionId,
					task: params.question,
					context: {
						symbols: params.symbol ? [params.symbol] : undefined,
						timeframes: params.timeframe ? [params.timeframe] : undefined,
					},
				},
				subagentContext(ctx),
				{ ...runnerOptions(signal), onUpdate, readOnly: true },
			);
			if (output.isError) throw new Error(output.content[0].text);
			return output;
		},
	});
}

export { ALLOWED_CHILD_TOOLS, discoverAgents, parseToolList, resolveChildTools } from "./agents.ts";
export { buildProposedOrder, extractProposedOrder, formatProposedOrders, PROPOSE_ORDER_TOOL } from "./child-orders.ts";
export {
	assistantText,
	childEnvironment,
	resolveChildOrdersExtension,
	resolveCodingAgentCli,
	resolveSiblingMarketLab,
	runIsolatedChild,
} from "./isolated-child.ts";
export { buildChildSystemPrompt, PER_TASK_OUTPUT_CAP, runSubagent, truncateBytes } from "./runner.ts";
