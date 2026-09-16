/**
 * Spawn a read-only coding-agent child. The child has no Ti trading runtime
 * and no exchange credentials; callers must already have allowlisted tools.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { extractProposedOrder, PROPOSE_ORDER_TOOL, type ProposedOrder } from "./child-orders.ts";
import {
	type AnalysisReport,
	asRecord,
	type ChildManifest,
	type Evidence,
	extractEvidence,
	FINISH_ANALYSIS_TOOL,
	FORCE_KILL_DELAY_MS,
	parseReport,
} from "./protocol.ts";

export { FORCE_KILL_DELAY_MS };
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export type IsolatedChildContent =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; arguments: Record<string, unknown> };

export type IsolatedChildMessage = {
	role: string;
	content: IsolatedChildContent[];
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
};

export type IsolatedChildEvent =
	| { type: "message_end" | "tool_result_end"; message: IsolatedChildMessage }
	| { type: "tool_execution_end"; toolName: string; isError: boolean; result: unknown };

export type IsolatedChildRequest = {
	cwd: string;
	prompt: string;
	systemPrompt: string;
	tools: readonly string[];
	extensionPaths: readonly string[];
	sessionFile: string;
	sessionId: string;
	manifest: ChildManifest;
	onRequest: (name: string, args: unknown, signal: AbortSignal) => Promise<unknown>;
	onSpawn?: (pid: number) => void;
	model?: string;
	thinkingLevel?: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
	maxTokens?: number;
	signal: AbortSignal;
	onEvent?: (event: IsolatedChildEvent) => void;
};

export type IsolatedChildResult = {
	exitCode: number;
	messages: IsolatedChildMessage[];
	proposals?: ProposedOrder[];
	report?: AnalysisReport;
	evidence?: Evidence[];
	stderr: string;
	aborted: boolean;
	timedOut: boolean;
	outputTooLarge: boolean;
	error?: string;
};

type Termination = "abort" | "timeout" | "output" | "protocol" | "budget";

export function resolveCodingAgentCli(): string {
	const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const packageEntryDirectory = path.dirname(packageEntry);
	const packageRoot = path.resolve(packageEntryDirectory, "..");
	const candidates = [
		path.join(packageEntryDirectory, "bundle", "cli.js"),
		path.join(packageEntryDirectory, "cli.js"),
		path.join(packageRoot, "dist", "bundle", "cli.js"),
		path.join(packageRoot, "dist", "cli.js"),
		path.join(packageEntryDirectory, "cli.ts"),
		path.join(packageRoot, "src", "cli.ts"),
	];
	const cli = candidates.find((candidate) => existsSync(candidate));
	if (!cli) throw new Error("Unable to locate the pi coding-agent CLI");
	return cli;
}

export function resolveSiblingMarketLab(fromFile: string): string {
	const extensionDirectory = path.dirname(fromFile);
	const compiled = path.resolve(extensionDirectory, "../market-lab/index.js");
	if (existsSync(compiled)) return compiled;
	const source = path.resolve(extensionDirectory, "../market-lab/index.ts");
	if (existsSync(source)) return source;
	throw new Error("Unable to locate the bundled market-lab extension");
}

export function resolveChildOrdersExtension(fromFile: string): string {
	const extensionDirectory = path.dirname(fromFile);
	const compiled = path.join(extensionDirectory, "child-orders.js");
	if (existsSync(compiled)) return compiled;
	const source = path.join(extensionDirectory, "child-orders.ts");
	if (existsSync(source)) return source;
	throw new Error("Unable to locate the bundled subagent order-proposal extension");
}

export function resolveChildToolsExtension(fromFile: string): string {
	const directory = path.dirname(fromFile);
	const compiled = path.join(directory, "child-tools.js");
	if (existsSync(compiled)) return compiled;
	const source = path.join(directory, "child-tools.ts");
	if (existsSync(source)) return source;
	throw new Error("Unable to locate child research tools");
}

function emptyChildResult(error: string, aborted = false): IsolatedChildResult {
	return {
		exitCode: 1,
		messages: [],
		proposals: [],
		stderr: "",
		aborted,
		timedOut: false,
		outputTooLarge: false,
		error,
	};
}

export function childEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of [
		"HOME",
		"PATH",
		"TMPDIR",
		"TMP",
		"TEMP",
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
		"TZ",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
	]) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	const dataRoot = process.env.TI_DATA_DIR?.trim() || path.join(homedir(), ".ti-trader");
	env.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? path.join(dataRoot, "agent");
	return env;
}

export function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
	if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
	let signaled = false;
	if (process.platform !== "win32") {
		try {
			process.kill(-pid, signal);
			signaled = true;
		} catch {
			// The process may not have become a group leader yet.
		}
	}
	try {
		process.kill(pid, signal);
		signaled = true;
	} catch {
		// Already gone, or the process-group signal was enough.
	}
	return signaled;
}

function killChild(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
	if (child.pid === undefined || !signalProcessGroup(child.pid, signal)) child.kill(signal);
}

function parseContent(value: unknown): IsolatedChildContent[] {
	if (!Array.isArray(value)) return [];
	const parts: IsolatedChildContent[] = [];
	for (const item of value) {
		const part = asRecord(item);
		if (!part) continue;
		if (part.type === "text" && typeof part.text === "string") {
			parts.push({ type: "text", text: part.text });
			continue;
		}
		if (part.type === "toolCall" && typeof part.name === "string") {
			const args = asRecord(part.arguments) ?? asRecord(part.args) ?? {};
			parts.push({ type: "toolCall", name: part.name, arguments: args });
		}
	}
	return parts;
}

function parseUsage(value: unknown): IsolatedChildMessage["usage"] {
	const usage = asRecord(value);
	if (!usage) return undefined;
	const cost = asRecord(usage.cost);
	return {
		input: typeof usage.input === "number" ? usage.input : undefined,
		output: typeof usage.output === "number" ? usage.output : undefined,
		cacheRead: typeof usage.cacheRead === "number" ? usage.cacheRead : undefined,
		cacheWrite: typeof usage.cacheWrite === "number" ? usage.cacheWrite : undefined,
		totalTokens: typeof usage.totalTokens === "number" ? usage.totalTokens : undefined,
		cost: cost && typeof cost.total === "number" ? { total: cost.total } : undefined,
	};
}

function parseMessage(value: unknown): IsolatedChildMessage | undefined {
	const message = asRecord(value);
	if (!message || typeof message.role !== "string") return undefined;
	return {
		role: message.role,
		content: parseContent(message.content),
		model: typeof message.model === "string" ? message.model : undefined,
		stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
		errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
		usage: parseUsage(message.usage),
	};
}

function parseEvent(line: string): IsolatedChildEvent | undefined {
	if (!line.trim()) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	const event = asRecord(parsed);
	if (!event) return undefined;
	if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
		return {
			type: "tool_execution_end",
			toolName: event.toolName,
			isError: event.isError === true,
			result: event.result,
		};
	}
	if (event.type !== "message_end" && event.type !== "tool_result_end") return undefined;
	const message = parseMessage(event.message);
	if (!message) return undefined;
	return { type: event.type, message };
}

function writePromptFile(agentLabel: string, prompt: string): { dir: string; filePath: string } {
	const dir = mkdtempSync(path.join(tmpdir(), "ti-subagent-"));
	const safeName = agentLabel.replace(/[^\w.-]+/g, "_") || "agent";
	const filePath = path.join(dir, `prompt-${safeName}.md`);
	writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

export async function runIsolatedChild(request: IsolatedChildRequest): Promise<IsolatedChildResult> {
	if (request.signal.aborted) return emptyChildResult("Subagent was cancelled", true);
	if (request.tools.length === 0) return emptyChildResult("Subagent tool allowlist is empty");
	if (!request.sessionFile || !existsSync(request.sessionFile) || !request.sessionId)
		return emptyChildResult("Persistent subagent history is required");

	const timeoutMs = request.timeoutMs;
	const maxOutputBytes = request.maxOutputBytes ?? MAX_OUTPUT_BYTES;
	const tmp = writePromptFile("system", request.systemPrompt);
	const manifestFile = path.join(tmp.dir, "manifest.json");
	writeFileSync(manifestFile, JSON.stringify(request.manifest), { mode: 0o600 });
	const args = [
		resolveCodingAgentCli(),
		"--mode",
		"json",
		"--print",
		"--session",
		request.sessionFile,
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-builtin-tools",
		"--system-prompt",
		tmp.filePath,
	];
	for (const extension of request.extensionPaths) {
		args.push("--extension", extension);
	}
	args.push("--tools", request.tools.join(","));
	if (request.model) args.push("--model", request.model);
	if (request.thinkingLevel) args.push("--thinking", request.thinkingLevel);
	args.push("--", request.prompt);

	const messages: IsolatedChildMessage[] = [];
	const proposals: ProposedOrder[] = [];
	const evidence: Evidence[] = [...request.manifest.evidence];
	let report: AnalysisReport | undefined;
	let headerSeen = false;
	let tokens = 0;
	let stderr = "";
	let outputBytes = 0;
	let termination: Termination | undefined;
	let spawnError: Error | undefined;
	let protocolError: string | undefined;
	const rpcAbort = new AbortController();
	const rpcSignal = AbortSignal.any([request.signal, rpcAbort.signal]);

	try {
		const exitCode = await new Promise<number>((resolve, reject) => {
			const child = spawn(process.execPath, args, {
				cwd: request.cwd,
				stdio: ["ignore", "pipe", "pipe", "ipc"],
				shell: false,
				detached: process.platform !== "win32",
				env: { ...childEnvironment(), TI_SUBAGENT_MANIFEST: manifestFile },
			});
			const decoder = new StringDecoder("utf8");
			const requestIds = new Set<string>();
			let buffer = "";
			let settled = false;
			let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

			const finish = (callback: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (forceKillTimer) clearTimeout(forceKillTimer);
				rpcAbort.abort();
				request.signal.removeEventListener("abort", abort);
				callback();
			};
			const terminate = (reason: Termination): void => {
				if (termination) return;
				termination = reason;
				rpcAbort.abort();
				if (settled) return;
				killChild(child, "SIGTERM");
				forceKillTimer = setTimeout(() => killChild(child, "SIGKILL"), FORCE_KILL_DELAY_MS);
				forceKillTimer.unref?.();
			};
			const timeout = timeoutMs === undefined ? undefined : setTimeout(() => terminate("timeout"), timeoutMs);
			timeout?.unref();
			const abort = (): void => terminate("abort");
			request.signal.addEventListener("abort", abort, { once: true });
			if (request.signal.aborted) abort();
			try {
				if (child.pid !== undefined) request.onSpawn?.(child.pid);
			} catch (error) {
				protocolError = error instanceof Error ? error.message : String(error);
				terminate("protocol");
			}
			child.on("message", (message: unknown) => {
				const event = asRecord(message);
				if (
					event?.kind !== "ti-subagent-call" ||
					typeof event.id !== "string" ||
					typeof event.name !== "string" ||
					event.id.length > 160 ||
					requestIds.has(event.id) ||
					(request.manifest.maxToolCalls !== undefined && requestIds.size >= request.manifest.maxToolCalls * 8) ||
					Buffer.byteLength(JSON.stringify(event.args) ?? "", "utf8") > 16 * 1024
				) {
					protocolError = "Invalid or excessive child research request";
					terminate("protocol");
					return;
				}
				requestIds.add(event.id);
				const id = event.id;
				const send = (payload: Record<string, unknown>): void => {
					if (!child.connected || settled || termination) return;
					child.send({ kind: "ti-subagent-result", id, ...payload }, (error) => {
						if (!error || settled) return;
						protocolError = "Research bridge disconnected";
						terminate("protocol");
					});
				};
				void request.onRequest(event.name, event.args, rpcSignal).then(
					(result) => send({ result }),
					(error) => send({ error: error instanceof Error ? error.message : "Research request failed" }),
				);
			});

			const processLine = (line: string): void => {
				if (termination) return;
				let raw: unknown;
				try {
					raw = JSON.parse(line);
				} catch {
					return;
				}
				const header = asRecord(raw);
				if (header?.type === "session") {
					if (header.id !== request.sessionId) {
						protocolError = "Child resumed a different session";
						terminate("protocol");
					} else headerSeen = true;
					return;
				}
				const event = parseEvent(line);
				if (!event) return;
				if (event.type === "tool_execution_end") {
					if (event.toolName === PROPOSE_ORDER_TOOL && !event.isError) {
						const proposal = extractProposedOrder(event.result);
						if (proposal) proposals.push(proposal);
					}
					const item = extractEvidence(event.result);
					if (item) evidence.push(item);
					if (event.toolName === FINISH_ANALYSIS_TOOL && !event.isError) {
						try {
							report = parseReport(asRecord(event.result)?.details, evidence);
						} catch (error) {
							protocolError = error instanceof Error ? error.message : "Invalid analysis report";
							terminate("protocol");
						}
					}
				} else {
					messages.push(event.message);
					if (event.message.role === "assistant" && event.message.usage) {
						const usage = event.message.usage;
						tokens += (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
						if (request.maxTokens !== undefined && tokens > request.maxTokens) terminate("budget");
					}
				}
				try {
					request.onEvent?.(event);
				} catch (error) {
					protocolError = error instanceof Error ? error.message : "Unable to persist research progress";
					terminate("protocol");
				}
			};

			const append = (target: "output" | "error", chunk: Buffer): void => {
				if (termination) return;
				outputBytes += chunk.byteLength;
				if (outputBytes > maxOutputBytes) {
					terminate("output");
					return;
				}
				if (target === "error") {
					stderr += chunk.toString();
					return;
				}
				buffer += decoder.write(chunk);
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			};

			child.stdout?.on("data", (chunk: Buffer) => append("output", chunk));
			child.stderr?.on("data", (chunk: Buffer) => append("error", chunk));
			child.on("error", (cause) => {
				spawnError = cause instanceof Error ? cause : new Error(String(cause));
				finish(() => reject(spawnError));
			});
			child.on("close", (code) => {
				buffer += decoder.end();
				if (buffer.trim()) processLine(buffer);
				finish(() => resolve(code ?? 1));
			});
		});

		const error =
			termination === "abort"
				? "Subagent was cancelled"
				: termination === "timeout"
					? "Subagent timed out"
					: termination === "output"
						? "Subagent output was too large"
						: termination === "budget"
							? "Subagent token budget exhausted"
							: (protocolError ?? (!headerSeen ? "Child did not confirm its persistent session" : undefined));
		return {
			exitCode: error ? 1 : exitCode,
			messages,
			proposals,
			report,
			evidence,
			stderr,
			aborted: termination === "abort",
			timedOut: termination === "timeout",
			outputTooLarge: termination === "output",
			error,
		};
	} finally {
		rpcAbort.abort();
		try {
			rmSync(tmp.dir, { recursive: true, force: true });
		} catch (error) {
			console.error(
				`Unable to remove subagent temporary files: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

export function assistantText(messages: IsolatedChildMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text" && part.text.trim()) return part.text;
		}
	}
	return "";
}
