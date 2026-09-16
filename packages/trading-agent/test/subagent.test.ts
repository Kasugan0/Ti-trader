import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_CHILD_TOOLS,
	discoverAgents,
	parseToolList,
	resolveChildTools,
} from "../../../extensions/subagent/agents.ts";
import { buildProposedOrder, extractProposedOrder } from "../../../extensions/subagent/child-orders.ts";
import {
	childEnvironment,
	FORCE_KILL_DELAY_MS,
	type IsolatedChildRequest,
	runIsolatedChild,
} from "../../../extensions/subagent/isolated-child.ts";
import { FINISH_ANALYSIS_TOOL, RESEARCH_RUNTIME_KEY } from "../../../extensions/subagent/protocol.ts";
import {
	buildChildSystemPrompt,
	PARENT_OUTPUT_BYTES,
	runSubagent,
	sessionStoreFor,
	truncateBytes,
} from "../../../extensions/subagent/runner.ts";
import { ChildSessionStore, type RunRecord } from "../../../extensions/subagent/sessions.ts";
import { childResult, persistChild, report, subagentFixture } from "./subagent-fixture.ts";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

let fixture: ReturnType<typeof subagentFixture>;
beforeEach(() => {
	fixture = subagentFixture();
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	spawnMock.mockReset();
	delete (globalThis as Record<PropertyKey, unknown>)[RESEARCH_RUNTIME_KEY];
	fixture.cleanup();
});

describe("specialist definitions", () => {
	it("discovers specialized roles and preserves the proposal-capable researcher", () => {
		const found = discoverAgents({
			cwd: fixture.directory,
			scope: "user",
			bundledDir: fixture.options.bundledDir,
			userDir: fixture.options.userDir,
		});
		expect(found.agents.map((item) => item.name).sort()).toEqual([
			"derivatives-analyst",
			"event-analyst",
			"researcher",
			"reviewer",
			"scanner",
			"strategy-analyst",
			"technical-analyst",
		]);
		expect(found.agents.find((item) => item.name === "researcher")?.tools).toContain("propose_order");
		expect(found.agents.find((item) => item.name === "technical-analyst")?.tools).not.toContain("propose_order");
		expect(found.agents.every((item) => resolveChildTools(item.tools).rejected.length === 0)).toBe(true);
		expect(found.agents.map((item) => item.budget)).toEqual(Array.from({ length: 7 }, () => ({})));
	});
	it("parses lists, keeps conservative defaults and rejects execution tools", () => {
		expect(parseToolList("calculate_indicators, evaluate_strategy")).toEqual([
			"calculate_indicators",
			"evaluate_strategy",
		]);
		expect(parseToolList(["screen_markets", "simulate_rule"])).toEqual(["screen_markets", "simulate_rule"]);
		expect(resolveChildTools(undefined).tools).toEqual(DEFAULT_CHILD_TOOLS);
		expect(resolveChildTools(["buy", "bash", "calculate_indicators"])).toEqual({
			tools: ["calculate_indicators"],
			rejected: ["buy", "bash"],
		});
	});
	it("loads model and bounded budgets from user definitions", () => {
		writeFileSync(
			join(fixture.options.userDir, "researcher.md"),
			"---\nname: researcher\ndescription: override\ntools: screen_markets\nmodel: faux/test\nmaxTurns: 3\nmaxToolCalls: 4\nmaxTokens: 8000\ntimeoutMs: 10000\n---\nOnly scan.\n",
		);
		const found = discoverAgents({
			cwd: fixture.directory,
			scope: "user",
			bundledDir: fixture.options.bundledDir,
			userDir: fixture.options.userDir,
		});
		expect(found.agents.find((item) => item.name === "researcher")).toMatchObject({
			source: "user",
			model: "faux/test",
			budget: { maxTurns: 3, maxToolCalls: 4, maxTokens: 8000, timeoutMs: 10000 },
		});
	});
	it("reports invalid role files rather than silently dropping them", () => {
		writeFileSync(
			join(fixture.options.userDir, "broken.md"),
			"---\nname: broken\ndescription: invalid\nmaxTurns: 0\n---\nx",
		);
		expect(() =>
			discoverAgents({
				cwd: fixture.directory,
				scope: "user",
				bundledDir: fixture.options.bundledDir,
				userDir: fixture.options.userDir,
			}),
		).toThrow("maxTurns");
	});
	it("accepts explicit budgets above the old ceilings", () => {
		writeFileSync(
			join(fixture.options.userDir, "researcher.md"),
			"---\nname: researcher\ndescription: extended\nmaxTurns: 1000\nmaxToolCalls: 1000\nmaxTokens: 2000000\ntimeoutMs: 3600000\n---\nAnalyze.",
		);
		const found = discoverAgents({
			cwd: fixture.directory,
			scope: "user",
			bundledDir: fixture.options.bundledDir,
			userDir: fixture.options.userDir,
		});
		expect(found.agents.find((item) => item.name === "researcher")?.budget).toEqual({
			maxTurns: 1000,
			maxToolCalls: 1000,
			maxTokens: 2000000,
			timeoutMs: 3600000,
		});
	});
	it("keeps safety and evidence requirements in the system prompt", () => {
		const prompt = buildChildSystemPrompt("Role body");
		expect(prompt).toContain("no exchange access");
		expect(prompt).toContain("finish_analysis");
		expect(prompt).toContain("Never claim a fill");
		expect(prompt).toContain("Role body");
	});
});

describe("persistent research orchestration", () => {
	it("waits for sibling runs and surfaces a durable-write failure without claiming success", async () => {
		const originalSave = ChildSessionStore.prototype.saveRun;
		vi.spyOn(ChildSessionStore.prototype, "saveRun").mockImplementation(function (
			this: ChildSessionStore,
			run: RunRecord,
		) {
			if (run.report?.summary === "write-fails") throw new Error("fixture disk failure");
			originalSave.call(this, run);
		});
		let siblingSettled = false;
		const output = await runSubagent(
			{
				tasks: [
					{ agent: "researcher", task: "first" },
					{ agent: "scanner", task: "second" },
				],
			},
			fixture.ctx,
			{
				...fixture.options,
				runChild: async (request) => {
					if (request.prompt.includes("Task: first")) return childResult("write-fails");
					await new Promise((resolve) => setTimeout(resolve, 20));
					siblingSettled = true;
					return childResult("saved");
				},
			},
		);
		expect(siblingSettled).toBe(true);
		expect(output.isError).toBe(true);
		expect(output.details.results).toHaveLength(2);
		expect(output.details.results[0].report).toBeUndefined();
		expect(output.details.results[0].errorMessage).toContain("Unable to persist");
		expect(output.details.results[1].report?.summary).toBe("saved");
	});
	it("creates a private session and resumes its full prior messages without changing its ID", async () => {
		const first = await runSubagent(
			{ agent: "researcher", task: "first research marker" },
			fixture.ctx,
			fixture.options,
		);
		expect(first.isError).toBeUndefined();
		const firstResult = first.details.results[0];
		const store = sessionStoreFor(fixture.ctx, fixture.options.sessionRoot);
		const file = store.historyPath(store.read(firstResult.sessionId!));
		expect(statSync(file).mode & 0o777).toBe(0o600);
		let restored = "";
		const runChild = vi.fn(async (request: IsolatedChildRequest) => {
			restored = JSON.stringify(SessionManager.open(request.sessionFile).buildSessionContext().messages);
			return persistChild(request, "updated");
		});
		const second = await runSubagent({ sessionId: firstResult.sessionId, task: "continue" }, fixture.ctx, {
			...fixture.options,
			runChild,
		});
		expect(second.isError).toBeUndefined();
		expect(restored).toContain("first research marker");
		expect(second.details.results[0].sessionId).toBe(firstResult.sessionId);
		expect(second.details.results[0].runId).not.toBe(firstResult.runId);
		expect(store.list().sessions[0]).toMatchObject({ runCount: 2, summary: "updated", status: "idle" });
		expect(readFileSync(file, "utf8")).toContain("continue");
	});
	it("refuses missing history instead of creating a replacement conversation", async () => {
		const first = await runSubagent({ agent: "researcher", task: "first" }, fixture.ctx, fixture.options);
		const id = first.details.results[0].sessionId!;
		const store = sessionStoreFor(fixture.ctx, fixture.options.sessionRoot);
		unlinkSync(store.historyPath(store.read(id)));
		const runChild = vi.fn();
		const second = await runSubagent({ sessionId: id, task: "continue" }, fixture.ctx, {
			...fixture.options,
			runChild,
		});
		expect(second.isError).toBe(true);
		expect(second.content[0].text).toContain("history is missing");
		expect(runChild).not.toHaveBeenCalled();
	});
	it("isolates sessions by parent/account scope", async () => {
		const first = await runSubagent({ agent: "researcher", task: "first" }, fixture.ctx, fixture.options);
		const runChild = vi.fn();
		const result = await runSubagent(
			{ sessionId: first.details.results[0].sessionId, task: "foreign" },
			{ ...fixture.ctx, parentSessionId: "other-parent" },
			{ ...fixture.options, runChild },
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not found");
		expect(runChild).not.toHaveBeenCalled();
	});
	it("rejects role changes on an existing session", async () => {
		const first = await runSubagent({ agent: "researcher", task: "first" }, fixture.ctx, fixture.options);
		const result = await runSubagent(
			{ sessionId: first.details.results[0].sessionId, agent: "reviewer", task: "switch" },
			fixture.ctx,
			fixture.options,
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("role or cwd changed");
	});
	it("rejects mixed modes and excessive fan-out without starting children", async () => {
		const runChild = vi.fn();
		const options = { ...fixture.options, runChild };
		expect(
			(
				await runSubagent(
					{ agent: "researcher", task: "x", tasks: [{ agent: "scanner", task: "x" }] },
					fixture.ctx,
					options,
				)
			).isError,
		).toBe(true);
		expect(
			(
				await runSubagent(
					{ tasks: Array.from({ length: 5 }, () => ({ agent: "scanner", task: "x" })) },
					fixture.ctx,
					options,
				)
			).content[0].text,
		).toContain("Too many parallel");
		expect(
			(
				await runSubagent(
					{ chain: Array.from({ length: 9 }, () => ({ agent: "scanner", task: "x" })) },
					fixture.ctx,
					options,
				)
			).content[0].text,
		).toContain("Too many chain");
		expect(runChild).not.toHaveBeenCalled();
	});
	it("rejects forbidden tools and reports missing event services explicitly", async () => {
		writeFileSync(
			join(fixture.options.userDir, "unsafe.md"),
			"---\nname: unsafe\ndescription: unsafe\ntools: buy\n---\nx",
		);
		const runChild = vi.fn();
		const options = { ...fixture.options, runChild };
		expect((await runSubagent({ agent: "unsafe", task: "x" }, fixture.ctx, options)).content[0].text).toContain(
			"allowlist",
		);
		expect(
			(await runSubagent({ agent: "event-analyst", task: "news" }, fixture.ctx, options)).content[0].text,
		).toContain("No research tools");
		expect(runChild).not.toHaveBeenCalled();
	});
	it("passes the effective model, budget and only available tools", async () => {
		const runChild = vi.fn(async (_request: IsolatedChildRequest) => childResult());
		await runSubagent(
			{ agent: "technical-analyst", task: "analyze" },
			{ ...fixture.ctx, model: { provider: "faux", id: "model" }, thinkingLevel: "medium" },
			{ ...fixture.options, runChild },
		);
		const request = runChild.mock.calls[0]?.[0];
		expect(request).toMatchObject({
			model: "faux/model",
			thinkingLevel: "medium",
		});
		expect(request?.timeoutMs).toBeUndefined();
		expect(request?.maxTokens).toBeUndefined();
		expect(request?.manifest.maxTurns).toBeUndefined();
		expect(request?.manifest.maxToolCalls).toBeUndefined();
		expect(request?.manifest.timeoutMs).toBeUndefined();
		expect(request?.tools).toContain(FINISH_ANALYSIS_TOOL);
		expect(request?.tools).toContain("read_evidence");
		expect(request?.tools).not.toContain("get_price");
		expect(request?.tools).not.toContain("propose_order");
	});
	it("does not impose the former ten-minute batch deadline", async () => {
		vi.useFakeTimers();
		const timeout = vi.spyOn(AbortSignal, "timeout");
		const pending = runSubagent({ agent: "researcher", task: "long analysis" }, fixture.ctx, {
			...fixture.options,
			runChild: async (request) => {
				await new Promise((resolve) => setTimeout(resolve, 1_200_000));
				request.signal.throwIfAborted();
				return childResult();
			},
		});
		await vi.advanceTimersByTimeAsync(1_200_001);
		expect((await pending).isError).toBeUndefined();
		expect(timeout).not.toHaveBeenCalled();
	});
	it("runs parallel research and a reviewer with source reports without a parent round-trip", async () => {
		const requests: IsolatedChildRequest[] = [];
		const result = await runSubagent(
			{
				tasks: [
					{ agent: "scanner", task: "scan" },
					{ agent: "technical-analyst", task: "technical" },
				],
				review: { agent: "reviewer", task: "compare" },
			},
			fixture.ctx,
			{
				...fixture.options,
				runChild: async (request) => {
					requests.push(request);
					return childResult(request.prompt.includes("Task: scan") ? "scan result" : "technical result");
				},
			},
		);
		expect(result.isError).toBeUndefined();
		expect(requests).toHaveLength(3);
		expect(requests[2].prompt).toContain("scan result");
		expect(requests[2].prompt).toContain("technical result");
		expect(new Set(result.details.results.map((item) => item.sessionId)).size).toBe(3);
	});
	it("caps active children across separate invocations, not just one tasks array", async () => {
		let active = 0;
		let peak = 0;
		const runChild = async () => {
			active++;
			peak = Math.max(active, peak);
			await new Promise((resolve) => setTimeout(resolve, 10));
			active--;
			return childResult();
		};
		const outputs = await Promise.all(
			Array.from({ length: 4 }, () =>
				runSubagent({ agent: "scanner", task: "scan" }, fixture.ctx, { ...fixture.options, runChild }),
			),
		);
		expect(outputs.every((item) => !item.isError)).toBe(true);
		expect(peak).toBe(2);
	});
	it("refuses concurrent continuation of one conversation", async () => {
		const first = await runSubagent({ agent: "scanner", task: "scan" }, fixture.ctx, fixture.options);
		const id = first.details.results[0].sessionId!;
		let release: (() => void) | undefined;
		let started: (() => void) | undefined;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const pending = runSubagent({ sessionId: id, task: "slow" }, fixture.ctx, {
			...fixture.options,
			runChild: async () => {
				started!();
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return childResult();
			},
		});
		await ready;
		const second = await runSubagent({ sessionId: id, task: "conflict" }, fixture.ctx, fixture.options);
		expect(second.isError).toBe(true);
		expect(second.content[0].text).toContain("busy");
		release!();
		expect((await pending).isError).toBeUndefined();
	});
	it("substitutes chain reports and stops on an explicit child failure", async () => {
		const requests: string[] = [];
		const output = await runSubagent(
			{
				chain: [
					{ agent: "scanner", task: "first" },
					{ agent: "reviewer", task: "review {previous}" },
					{ agent: "researcher", task: "third" },
				],
			},
			fixture.ctx,
			{
				...fixture.options,
				runChild: async (request) => {
					requests.push(request.prompt);
					return requests.length === 1
						? childResult("first-report")
						: { ...childResult(), exitCode: 1, error: "fixture failure" };
				},
			},
		);
		expect(requests).toHaveLength(2);
		expect(requests[1]).toContain("first-report");
		expect(output.isError).toBe(true);
		expect(output.content[0].text).toContain("Chain stopped at step 2");
	});
	it("requires an actual structured report and rejects invented citations", async () => {
		const missing = await runSubagent({ agent: "researcher", task: "x" }, fixture.ctx, {
			...fixture.options,
			runChild: async () => ({ ...childResult(), report: undefined }),
		});
		expect(missing.content[0].text).toContain("without a validated");
		const invalid = await runSubagent({ agent: "researcher", task: "x" }, fixture.ctx, {
			...fixture.options,
			runChild: async () => ({
				...childResult(),
				report: { ...report(), findings: [{ claim: "invented", evidenceIds: ["missing"] }] },
			}),
		});
		expect(invalid.isError).toBe(true);
		expect(invalid.content[0].text).toContain("unavailable evidence");
	});
	it("keeps pending proposals with full order fields, but never replays them on continuation", async () => {
		const proposal = buildProposedOrder({
			side: "sell",
			symbol: "BTC/USDT",
			type: "stop_market",
			amount: 1,
			stopPrice: 90,
		});
		const first = await runSubagent({ agent: "researcher", task: "proposal" }, fixture.ctx, {
			...fixture.options,
			runChild: async () => ({ ...childResult(), proposals: [proposal] }),
		});
		expect(first.details.proposals[0]).toMatchObject({ submitted: false, stopPrice: 90, id: expect.any(String) });
		const second = await runSubagent(
			{ sessionId: first.details.results[0].sessionId, task: "continue" },
			fixture.ctx,
			fixture.options,
		);
		expect(second.details.proposals).toEqual([]);
	});
	it("preserves project trust on new calls and continuation", async () => {
		const projectDir = join(fixture.directory, ".ti-trader", "agents");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(projectDir, "local.md"),
			"---\nname: local\ndescription: Project\ntools: screen_markets\n---\nProject body",
		);
		const params = { agent: "local", task: "scan", agentScope: "both" as const, confirmProjectAgents: false };
		expect((await runSubagent(params, fixture.ctx, fixture.options)).content[0].text).toContain(
			"require confirmation",
		);
		const trusted = await runSubagent(params, { ...fixture.ctx, isProjectTrusted: () => true }, fixture.options);
		expect(trusted.isError).toBeUndefined();
		const resumed = await runSubagent(
			{ sessionId: trusted.details.results[0].sessionId, task: "continue" },
			fixture.ctx,
			fixture.options,
		);
		expect(resumed.isError).toBe(true);
		expect(resumed.content[0].text).toContain("require confirmation");
	});
	it("preserves readable UTF-8 and enforces a parent-visible aggregate output limit", async () => {
		expect(truncateBytes("市场市场", 7)).toBe("市场");
		const large = {
			...report("市".repeat(600)),
			risks: Array(4).fill("风".repeat(180)),
			invalidation: Array(4).fill("险".repeat(180)),
			unknowns: [],
		};
		const output = await runSubagent(
			{ chain: Array.from({ length: 8 }, () => ({ agent: "researcher", task: "analyze" })) },
			fixture.ctx,
			{
				...fixture.options,
				runChild: async () => ({ ...childResult(), report: large }),
			},
		);
		expect(output.isError).toBeUndefined();
		expect(Buffer.byteLength(output.content[0].text)).toBeLessThanOrEqual(PARENT_OUTPUT_BYTES);
		expect(output.content[0].text).toContain("reportOmitted");
		expect(output.details.results).toHaveLength(8);
	});
});

function mockProcess() {
	const child = new EventEmitter() as EventEmitter & {
		pid?: number;
		connected: boolean;
		stdout: PassThrough;
		stderr: PassThrough;
		kill: ReturnType<typeof vi.fn>;
		send: ReturnType<typeof vi.fn>;
	};
	child.connected = true;
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = vi.fn();
	child.send = vi.fn();
	return child;
}

async function requestFixture(): Promise<IsolatedChildRequest> {
	let request: IsolatedChildRequest | undefined;
	await runSubagent({ agent: "researcher", task: "test" }, fixture.ctx, {
		...fixture.options,
		runChild: async (input) => {
			request = input;
			return childResult();
		},
	});
	if (!request) throw new Error("Fixture child was not invoked");
	return { ...request, signal: new AbortController().signal, onSpawn: undefined, onEvent: undefined };
}

describe("isolated persistent child process", () => {
	it("has no default time, token or cumulative IPC budget and remains cancellable", async () => {
		const request = await requestFixture();
		vi.useFakeTimers();
		const child = mockProcess();
		spawnMock.mockReturnValue(child);
		const controller = new AbortController();
		const onRequest = vi.fn(async () => ({ source: "fixture" }));
		const pending = runIsolatedChild({ ...request, signal: controller.signal, onRequest });
		child.stdout.write(`${JSON.stringify({ type: "session", id: request.sessionId })}\n`);
		child.stdout.write(
			`${JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [], usage: { input: 2_000_000 } },
			})}\n`,
		);
		for (let index = 0; index < 200; index++)
			child.emit("message", { kind: "ti-subagent-call", id: `read-${index}`, name: "__candles", args: {} });
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(onRequest).toHaveBeenCalledTimes(200);
		expect(child.kill).not.toHaveBeenCalled();
		controller.abort();
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		child.emit("close", null);
		expect(await pending).toMatchObject({ aborted: true, timedOut: false, outputTooLarge: false });
	});
	it("passes exact history, restricted environment, IPC and no coding tools", async () => {
		const child = mockProcess();
		spawnMock.mockReturnValue(child);
		const request = await requestFixture();
		vi.stubEnv("TI_TEST_API_KEY", "fixture-secret");
		const pending = runIsolatedChild(request);
		child.stdout.write(`${JSON.stringify({ type: "session", id: request.sessionId })}\n`);
		child.stdout.write(
			`${JSON.stringify({ type: "tool_execution_end", toolName: FINISH_ANALYSIS_TOOL, isError: false, result: { details: report("saved") } })}\n`,
		);
		child.emit("close", 0);
		const result = await pending;
		expect(result.error).toBeUndefined();
		expect(result.report?.summary).toBe("saved");
		const [command, args, options] = spawnMock.mock.calls[0] as [
			string,
			string[],
			{ env: NodeJS.ProcessEnv; stdio: string[]; shell: boolean; detached: boolean },
		];
		expect(command).toBe(process.execPath);
		expect(args).toEqual(
			expect.arrayContaining(["--session", request.sessionFile, "--no-builtin-tools", "--no-context-files"]),
		);
		expect(args).not.toContain("--no-session");
		expect(options.stdio).toContain("ipc");
		expect(options.shell).toBe(false);
		expect(options.detached).toBe(process.platform !== "win32");
		expect(options.env.TI_TEST_API_KEY).toBeUndefined();
		expect(existsSync(options.env.TI_SUBAGENT_MANIFEST!)).toBe(false);
	});
	it("rejects missing history before spawning", async () => {
		const request = await requestFixture();
		unlinkSync(request.sessionFile);
		expect((await runIsolatedChild(request)).error).toContain("history is required");
		expect(spawnMock).not.toHaveBeenCalled();
	});
	it("does not spawn a pre-cancelled request", async () => {
		const request = await requestFixture();
		const signal = AbortSignal.abort();
		expect((await runIsolatedChild({ ...request, signal })).aborted).toBe(true);
		expect(spawnMock).not.toHaveBeenCalled();
	});
	it.each(["abort", "timeout"] as const)("escalates %s to SIGKILL and waits for close", async (kind) => {
		const request = await requestFixture();
		vi.useFakeTimers();
		const child = mockProcess();
		child.pid = 43111;
		spawnMock.mockReturnValue(child);
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const controller = new AbortController();
		const pending = runIsolatedChild({ ...request, signal: controller.signal, timeoutMs: 1000 });
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		if (kind === "abort") controller.abort();
		else await vi.advanceTimersByTimeAsync(1000);
		expect(kill).toHaveBeenCalledWith(-43111, "SIGTERM");
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(FORCE_KILL_DELAY_MS);
		expect(kill).toHaveBeenCalledWith(-43111, "SIGKILL");
		child.emit("close", null);
		expect((await pending)[kind === "abort" ? "aborted" : "timedOut"]).toBe(true);
	});
	it("rejects an unexpected session header and output over budget", async () => {
		const request = await requestFixture();
		const first = mockProcess();
		spawnMock.mockReturnValueOnce(first);
		const pending = runIsolatedChild(request);
		first.stdout.write(`${JSON.stringify({ type: "session", id: "wrong" })}\n`);
		first.emit("close", 0);
		expect((await pending).error).toContain("different session");
		const second = mockProcess();
		spawnMock.mockReturnValueOnce(second);
		const output = runIsolatedChild({ ...request, maxOutputBytes: 10 });
		second.stdout.write("x".repeat(20));
		second.emit("close", 0);
		expect((await output).outputTooLarge).toBe(true);
	});
	it("preserves UTF-8 split across stdout chunks", async () => {
		const request = await requestFixture();
		const child = mockProcess();
		spawnMock.mockReturnValue(child);
		const pending = runIsolatedChild(request);
		const bytes = Buffer.from(
			`${JSON.stringify({ type: "session", id: request.sessionId })}\n${JSON.stringify({ type: "tool_execution_end", toolName: FINISH_ANALYSIS_TOOL, result: { details: report("市场") } })}\n`,
		);
		for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
		child.emit("close", 0);
		expect((await pending).report?.summary).toBe("市场");
	});
	it("does not turn signal termination into a successful exit", async () => {
		const request = await requestFixture();
		const child = mockProcess();
		spawnMock.mockReturnValue(child);
		const pending = runIsolatedChild(request);
		child.stdout.write(`${JSON.stringify({ type: "session", id: request.sessionId })}\n`);
		child.emit("close", null, "SIGKILL");
		expect((await pending).exitCode).not.toBe(0);
	});
	it("bounds model token use and dispatches reviewed IPC requests", async () => {
		const request = await requestFixture();
		const child = mockProcess();
		spawnMock.mockReturnValue(child);
		const onRequest = vi.fn(async () => ({ source: "fixture" }));
		const pending = runIsolatedChild({ ...request, maxTokens: 10, onRequest });
		child.emit("message", { kind: "ti-subagent-call", id: "read-1", name: "__candles", args: {} });
		await Promise.resolve();
		expect(onRequest).toHaveBeenCalled();
		child.stdout.write(
			`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 11 } } })}\n`,
		);
		child.emit("close", 0);
		expect((await pending).error).toContain("token budget");
	});
	it("reuses only the model/auth directory from Ti configuration", () => {
		vi.stubEnv("TI_DATA_DIR", fixture.directory);
		vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
		vi.stubEnv("TI_TEST_API_KEY", "fixture-secret");
		const env = childEnvironment();
		expect(env.PI_CODING_AGENT_DIR).toBe(join(fixture.directory, "agent"));
		expect(env.TI_TEST_API_KEY).toBeUndefined();
		expect(env.TI_DATA_DIR).toBeUndefined();
	});
});

describe("non-executing order proposals", () => {
	it("rejects fills and keeps exact order constraints", () => {
		const proposal = buildProposedOrder({ side: "buy", symbol: "btc/usdt", type: "market", quoteAmount: 100 });
		expect(proposal).toMatchObject({ submitted: false, pendingParent: true, symbol: "BTC/USDT" });
		expect(extractProposedOrder({ details: proposal })).toEqual(proposal);
		expect(extractProposedOrder({ ...proposal, submitted: true })).toBeUndefined();
		expect(() => buildProposedOrder({ side: "buy", symbol: "BTC/USDT", type: "limit", amount: 1 })).toThrow(
			"requires price",
		);
	});
});
