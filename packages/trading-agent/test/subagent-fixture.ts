import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { IsolatedChildRequest, IsolatedChildResult } from "../../../extensions/subagent/isolated-child.ts";
import type { AnalysisReport } from "../../../extensions/subagent/protocol.ts";
import type { SubagentContext, SubagentRunnerOptions } from "../../../extensions/subagent/runner.ts";
import { fauxAssistantMessage } from "../../ai/src/providers/faux.ts";

export function report(summary = "Wait; evidence is insufficient"): AnalysisReport {
	return { summary, findings: [], risks: [], invalidation: [], unknowns: ["No trading authorization"], bias: "none" };
}

export function childResult(summary = "Wait"): IsolatedChildResult {
	return {
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: summary }], stopReason: "stop" }],
		proposals: [],
		report: report(summary),
		evidence: [],
		stderr: "",
		aborted: false,
		timedOut: false,
		outputTooLarge: false,
	};
}

export function persistChild(request: IsolatedChildRequest, text = "Wait"): IsolatedChildResult {
	const manager = SessionManager.open(request.sessionFile);
	manager.appendMessage({ role: "user", content: request.prompt, timestamp: Date.now() });
	manager.appendMessage(fauxAssistantMessage(text));
	return childResult(text);
}

export function subagentFixture() {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "ti-subagent-tests-")));
	const userDir = join(directory, "agents");
	mkdirSync(userDir);
	const ctx: SubagentContext = {
		cwd: directory,
		parentSessionId: "parent-fixture",
		hasUI: false,
		isProjectTrusted: () => false,
	};
	const options: SubagentRunnerOptions = {
		bundledDir: fileURLToPath(new URL("../../../extensions/subagent/agents", import.meta.url)),
		userDir,
		extensionFileUrl: new URL("../../../extensions/subagent/index.ts", import.meta.url).href,
		sessionRoot: join(directory, "sessions"),
		signal: new AbortController().signal,
		runChild: async (request) => persistChild(request),
	};
	return { directory, ctx, options, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

export function extensionFixture(cwd: string) {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, unknown>();
	const api = {
		registerTool: (tool: ToolDefinition) => {
			tools.set(tool.name, tool);
		},
		on: (event: string, handler: unknown) => {
			handlers.set(event, handler);
		},
	} as ExtensionAPI;
	const ctx: ExtensionContext = {
		cwd,
		hasUI: false,
		thinkingLevel: "off",
		mode: "print",
		sessionManager: SessionManager.inMemory(cwd),
		isProjectTrusted: () => false,
		get ui(): never {
			throw new Error("Fixture UI is unavailable");
		},
		get modelRegistry(): never {
			throw new Error("Fixture must not resolve real models");
		},
		model: undefined,
		scopedModels: [],
		signal: undefined,
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {
			throw new Error("Unexpected fixture abort");
		},
		shutdown: () => {
			throw new Error("Unexpected fixture shutdown");
		},
		compact: () => {
			throw new Error("Unexpected fixture compaction");
		},
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
	};
	return {
		api,
		ctx,
		tools,
		execute(name: string, args: unknown) {
			const tool = tools.get(name);
			if (!tool) throw new Error(`Unknown fixture tool: ${name}`);
			return tool.execute("fixture-call", args, new AbortController().signal, undefined, ctx);
		},
		emit(name: string, event: Record<string, unknown>, context: unknown = ctx): unknown {
			const handler = handlers.get(name);
			if (typeof handler !== "function") throw new Error(`Unknown fixture event: ${name}`);
			return handler({ type: name, ...event }, context);
		},
	};
}
