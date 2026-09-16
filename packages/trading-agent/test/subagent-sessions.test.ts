import { spawn } from "node:child_process";
import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { releaseFileLock } from "@nikopack/ti-trading-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgents } from "../../../extensions/subagent/agents.ts";
import { ChildSessionStore } from "../../../extensions/subagent/sessions.ts";
import { report, subagentFixture } from "./subagent-fixture.ts";

let fixture: ReturnType<typeof subagentFixture>;
let store: ChildSessionStore;
beforeEach(() => {
	fixture = subagentFixture();
	store = new ChildSessionStore("fixture-owner", fixture.options.sessionRoot);
});
afterEach(() => fixture.cleanup());

function createSession() {
	const agent = discoverAgents({
		cwd: fixture.directory,
		scope: "user",
		bundledDir: fixture.options.bundledDir,
		userDir: fixture.options.userDir,
	}).agents[0];
	return store.create({ agent, agentScope: "user", cwd: fixture.directory, task: "Investigate" });
}

describe("durable child session registry", () => {
	it("can resume after a failed tool produced no details payload", () => {
		const session = createSession();
		const run = store.begin(session, "task");
		store.saveRun({
			...run,
			status: "failed",
			evidence: [
				{
					id: "failed-tool",
					tool: "calculate_indicators",
					observedAt: new Date().toISOString(),
					isError: true,
					result: { content: [{ type: "text", text: "Fixture request failed" }], details: undefined },
				},
			],
		});
		expect(store.readRun(session.id)).toMatchObject({ status: "failed", evidence: [{ isError: true }] });
	});
	it("writes a real header before the first model response and reopens after a store restart", () => {
		const session = createSession();
		const file = store.historyPath(session);
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
			type: "session",
			id: session.id,
			cwd: fixture.directory,
		});
		const reopened = new ChildSessionStore("fixture-owner", fixture.options.sessionRoot);
		expect(reopened.list().sessions[0].id).toBe(session.id);
		expect(reopened.historyPath(reopened.read(session.id))).toBe(file);
	});
	it("rejects foreign sessions, invalid IDs and corrupt metadata", () => {
		const session = createSession();
		expect(() => new ChildSessionStore("other-owner", fixture.options.sessionRoot).read(session.id)).toThrow(
			"not found",
		);
		expect(() => store.read("../outside")).toThrow("Invalid subagent session ID");
		writeFileSync(join(store.directory, session.id, "metadata.json"), '{"status":"idle"}');
		expect(() => store.read(session.id)).toThrow("Invalid subagent session metadata");
	});
	it("refuses another history ID and symlinked histories without modifying the target", () => {
		const session = createSession();
		const file = store.historyPath(session);
		writeFileSync(file, `${JSON.stringify({ type: "session", id: "foreign", cwd: fixture.directory })}\n`);
		expect(() => store.historyPath(session)).toThrow("identity mismatch");
		unlinkSync(file);
		const target = join(fixture.directory, "outside.jsonl");
		writeFileSync(target, "do not touch");
		symlinkSync(target, file);
		expect(() => store.historyPath(session)).toThrow("missing or invalid");
		expect(readFileSync(target, "utf8")).toBe("do not touch");
	});
	it("excludes simultaneous writers while allowing another session", () => {
		const first = createSession();
		const second = createSession();
		const lock = store.acquire(first.id);
		try {
			expect(() => store.acquire(first.id)).toThrow("busy");
			const other = store.acquire(second.id);
			releaseFileLock(other);
		} finally {
			releaseFileLock(lock);
		}
	});
	it("recovers an abandoned run but never evicts a still-live child", () => {
		const session = createSession();
		const run = store.begin(session, "interrupted task");
		store.save({ ...store.read(session.id), childPid: process.pid });
		expect(() => store.acquire(session.id)).toThrow(`busy: ${session.id} (pid ${process.pid})`);
		store.save({ ...store.read(session.id), childPid: undefined });
		const lock = new ChildSessionStore("fixture-owner", fixture.options.sessionRoot).acquire(session.id);
		try {
			expect(store.read(session.id).status).toBe("interrupted");
			expect(store.readRun(session.id, run.runId)).toMatchObject({
				status: "interrupted",
				error: expect.stringContaining("exited"),
			});
		} finally {
			releaseFileLock(lock);
		}
	});
	it("kills an orphaned child and recovers the abandoned run", async () => {
		const session = createSession();
		const run = store.begin(session, "orphaned task");
		const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			detached: process.platform !== "win32",
			stdio: "ignore",
		});
		if (orphan.pid === undefined) throw new Error("orphan pid");
		const pid = orphan.pid;
		orphan.unref();
		const waitFor = async (alive: boolean): Promise<boolean> => {
			const deadline = Date.now() + 1000;
			while (Date.now() < deadline) {
				try {
					process.kill(pid, 0);
					if (alive) return true;
				} catch {
					if (!alive) return true;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			return false;
		};
		try {
			expect(await waitFor(true)).toBe(true);
			store.save({ ...store.read(session.id), childPid: pid });
			const lock = store.acquire(session.id);
			try {
				const recovered = store.read(session.id);
				expect(recovered.status).toBe("interrupted");
				expect(recovered.childPid).toBeUndefined();
				expect(await waitFor(false)).toBe(true);
				expect(store.readRun(session.id, run.runId)).toMatchObject({
					status: "interrupted",
					error: expect.stringContaining("exited"),
				});
			} finally {
				releaseFileLock(lock);
			}
		} finally {
			try {
				if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
			} catch {
				// acquire() may already have killed the process group.
			}
			try {
				orphan.kill("SIGKILL");
			} catch {
				// The child handle is already closed after SIGKILL.
			}
		}
	});
	it("preserves a completed run if its metadata write was interrupted", () => {
		const session = createSession();
		const run = store.begin(session, "task");
		store.saveRun({
			...run,
			status: "completed",
			report: report("Durably completed"),
			finishedAt: new Date().toISOString(),
		});
		const lock = store.acquire(session.id);
		try {
			expect(store.readRun(session.id).status).toBe("completed");
			expect(store.read(session.id)).toMatchObject({ status: "idle", summary: "Durably completed" });
		} finally {
			releaseFileLock(lock);
		}
	});
	it("rejects corrupt run records and symlinked run directories", () => {
		const session = createSession();
		const run = store.begin(session, "task");
		const file = join(store.directory, session.id, "runs", `${run.runId}.json`);
		writeFileSync(file, JSON.stringify({ ...run, evidence: [{ id: "invented" }] }));
		expect(() => store.readRun(session.id)).toThrow("Invalid subagent run record");
		const other = createSession();
		symlinkSync(fixture.directory, join(store.directory, other.id, "runs"));
		expect(() => store.begin(other, "blocked")).toThrow("Invalid subagent run directory");
	});
	it("validates report citations and paginates without exposing history text", () => {
		const session = createSession();
		const run = store.begin(session, "task");
		const file = join(store.directory, session.id, "runs", `${run.runId}.json`);
		writeFileSync(
			file,
			JSON.stringify({
				...run,
				report: { ...report(), findings: [{ claim: "not backed", evidenceIds: ["unknown"] }] },
			}),
		);
		expect(() => store.readRun(session.id)).toThrow("unavailable evidence");
		createSession();
		expect(store.list(1, 1)).toMatchObject({
			total: 2,
			sessions: [expect.objectContaining({ id: expect.any(String) })],
		});
		expect(() => store.list(0)).toThrow("Invalid subagent session page");
	});
});
