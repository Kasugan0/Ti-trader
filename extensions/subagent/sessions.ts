import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	acquireFileLockSync,
	type FileLock,
	readJsonFile,
	releaseFileLock,
	syncFileAndDirectory,
	writeJsonFileDurable,
} from "@nikopack/ti-trading-engine";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { AgentConfig, AgentScope } from "./agents.ts";
import { extractProposedOrder, type ProposedOrder } from "./child-orders.ts";
import { signalProcessGroup } from "./isolated-child.ts";
import { type AnalysisReport, type Evidence, evidenceSchema, parseReport, reportSchema } from "./protocol.ts";

const idPattern = "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$";
export const sessionIdSchema = Type.String({ pattern: idPattern, description: "Exact persistent subagent session ID" });
const metadataSchema = Type.Object({
	version: Type.Literal(1),
	id: sessionIdSchema,
	owner: Type.String(),
	cwd: Type.String(),
	agent: Type.String(),
	agentScope: Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")]),
	fingerprint: Type.String(),
	fileName: Type.String(),
	model: Type.Optional(Type.String()),
	subject: Type.String(),
	createdAt: Type.String(),
	updatedAt: Type.String(),
	status: Type.Union([
		Type.Literal("idle"),
		Type.Literal("running"),
		Type.Literal("failed"),
		Type.Literal("interrupted"),
	]),
	runCount: Type.Integer({ minimum: 0 }),
	runId: Type.Optional(sessionIdSchema),
	childPid: Type.Optional(Type.Integer({ minimum: 1 })),
	summary: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
});
export type ChildSession = Static<typeof metadataSchema>;
export type RunRecord = {
	runId: string;
	sessionId: string;
	task: string;
	status: "running" | "completed" | "failed" | "interrupted";
	startedAt: string;
	finishedAt?: string;
	report?: AnalysisReport;
	proposals?: Array<ProposedOrder & { id: string }>;
	evidence: Evidence[];
	error?: string;
};
const runSchema = Type.Object({
	runId: sessionIdSchema,
	sessionId: sessionIdSchema,
	task: Type.String(),
	status: Type.Union([
		Type.Literal("running"),
		Type.Literal("completed"),
		Type.Literal("failed"),
		Type.Literal("interrupted"),
	]),
	startedAt: Type.String(),
	finishedAt: Type.Optional(Type.String()),
	report: Type.Optional(reportSchema),
	proposals: Type.Optional(Type.Array(Type.Object({ id: Type.String({ minLength: 1 }) }), { maxItems: 4 })),
	evidence: Type.Array(evidenceSchema),
	error: Type.Optional(Type.String()),
});

export function agentFingerprint(agent: AgentConfig): string {
	return createHash("sha256")
		.update(JSON.stringify([agent.name, agent.source, agent.filePath, agent.systemPrompt, agent.tools, agent.model]))
		.digest("hex");
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

export class ChildSessionStore {
	readonly directory: string;
	private readonly owner: string;

	constructor(owner: string, root?: string) {
		if (!owner.trim()) throw new Error("Subagent session ownership is required");
		this.owner = createHash("sha256").update(owner).digest("hex");
		const dataRoot = process.env.TI_DATA_DIR?.trim() || join(homedir(), ".ti-trader");
		const storageRoot = root ?? join(dataRoot, "agent", "subagents");
		mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
		if (lstatSync(storageRoot).isSymbolicLink() || !lstatSync(storageRoot).isDirectory())
			throw new Error("Invalid subagent storage directory");
		this.directory = join(storageRoot, this.owner);
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		if (lstatSync(this.directory).isSymbolicLink() || !lstatSync(this.directory).isDirectory())
			throw new Error("Invalid subagent ownership directory");
		chmodSync(this.directory, 0o700);
	}

	private directoryFor(id: string): string {
		if (!Value.Check(sessionIdSchema, id)) throw new Error("Invalid subagent session ID");
		const directory = join(this.directory, id);
		if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()))
			throw new Error("Invalid subagent session directory");
		return directory;
	}

	private metadataPath(id: string): string {
		return join(this.directoryFor(id), "metadata.json");
	}

	private runPath(sessionId: string, runId: string): string {
		if (!Value.Check(sessionIdSchema, runId)) throw new Error("Invalid subagent run ID");
		const directory = join(this.directoryFor(sessionId), "runs");
		if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()))
			throw new Error("Invalid subagent run directory");
		return join(directory, `${runId}.json`);
	}

	read(id: string): ChildSession {
		const file = this.metadataPath(id);
		if (!existsSync(file)) throw new Error(`Subagent session not found in this parent/account scope: ${id}`);
		if (lstatSync(file).isSymbolicLink()) throw new Error("Invalid subagent metadata path");
		const value = readJsonFile(file);
		if (!Value.Check(metadataSchema, value)) throw new Error(`Invalid subagent session metadata: ${id}`);
		const metadata = value as ChildSession;
		if (metadata.id !== id || metadata.owner !== this.owner) throw new Error("Subagent session ownership mismatch");
		return metadata;
	}

	save(metadata: ChildSession): void {
		if (!Value.Check(metadataSchema, metadata) || metadata.owner !== this.owner)
			throw new Error("Invalid subagent session metadata");
		writeJsonFileDurable(this.metadataPath(metadata.id), metadata, 0o600);
	}

	create(input: {
		agent: AgentConfig;
		agentScope: AgentScope;
		cwd: string;
		task: string;
		model?: string;
	}): ChildSession {
		const id = randomUUID();
		const directory = this.directoryFor(id);
		mkdirSync(directory, { mode: 0o700 });
		const manager = SessionManager.create(resolve(input.cwd), directory, { id });
		const file = manager.getSessionFile();
		const header = manager.getHeader();
		if (!file || !header) throw new Error("Unable to allocate persistent subagent history");
		writeFileSync(file, `${JSON.stringify(header)}\n`, { mode: 0o600, flag: "wx" });
		syncFileAndDirectory(file);
		const now = new Date().toISOString();
		const metadata: ChildSession = {
			version: 1,
			id,
			owner: this.owner,
			cwd: resolve(input.cwd),
			agent: input.agent.name,
			agentScope: input.agentScope,
			fingerprint: agentFingerprint(input.agent),
			fileName: basename(file),
			model: input.model,
			subject: input.task.slice(0, 240),
			createdAt: now,
			updatedAt: now,
			status: "idle",
			runCount: 0,
		};
		this.save(metadata);
		return metadata;
	}

	historyPath(metadata: ChildSession): string {
		if (basename(metadata.fileName) !== metadata.fileName || !metadata.fileName.endsWith(`_${metadata.id}.jsonl`))
			throw new Error("Invalid subagent history path");
		const file = join(this.directoryFor(metadata.id), metadata.fileName);
		if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
			throw new Error(`Subagent history is missing or invalid: ${metadata.id}`);
		const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		let header: unknown;
		try {
			const buffer = Buffer.alloc(64 * 1024);
			const size = readSync(fd, buffer, 0, buffer.length, 0);
			const end = buffer.subarray(0, size).indexOf(10);
			if (end < 0) throw new Error("Invalid or oversized subagent history header");
			header = JSON.parse(buffer.subarray(0, end).toString("utf8"));
		} finally {
			closeSync(fd);
		}
		if (
			!header ||
			typeof header !== "object" ||
			!("type" in header) ||
			header.type !== "session" ||
			!("id" in header) ||
			header.id !== metadata.id ||
			!("cwd" in header) ||
			header.cwd !== metadata.cwd
		)
			throw new Error("Subagent history identity mismatch");
		chmodSync(file, 0o600);
		return file;
	}

	acquire(id: string): FileLock {
		this.read(id);
		const lock = acquireFileLockSync(join(this.directoryFor(id), "run.lock"), {
			timeoutMs: 0,
			staleMs: Infinity,
			reclaimDeadOwner: true,
			timeoutMessage: () => `Subagent session is busy: ${id}`,
		});
		try {
			let metadata = this.read(id);
			if (metadata.childPid && processAlive(metadata.childPid)) {
				const pid = metadata.childPid;
				if (pid === process.pid || !signalProcessGroup(pid, "SIGKILL"))
					throw new Error(`Subagent session is busy: ${id} (pid ${pid})`);
				metadata = { ...metadata, childPid: undefined };
				this.save(metadata);
			}
			if (metadata.status === "running") {
				if (metadata.runId) {
					const previous = this.readRun(id, metadata.runId);
					if (previous.status === "running")
						this.saveRun({
							...previous,
							status: "interrupted",
							finishedAt: new Date().toISOString(),
							error: "Previous parent or child process exited before settling this run",
						});
					this.save({
						...metadata,
						status:
							previous.status === "completed" ? "idle" : previous.status === "failed" ? "failed" : "interrupted",
						childPid: undefined,
						summary: previous.report?.summary,
					});
				} else {
					this.save({ ...metadata, status: "interrupted", childPid: undefined });
				}
			}
			return lock;
		} catch (error) {
			releaseFileLock(lock);
			throw error;
		}
	}

	begin(metadata: ChildSession, task: string): RunRecord {
		const run: RunRecord = {
			runId: randomUUID(),
			sessionId: metadata.id,
			task,
			status: "running",
			startedAt: new Date().toISOString(),
			evidence: [],
		};
		this.saveRun(run);
		this.save({
			...metadata,
			runId: run.runId,
			status: "running",
			runCount: metadata.runCount + 1,
			updatedAt: run.startedAt,
			childPid: undefined,
			error: undefined,
		});
		return run;
	}

	saveRun(run: RunRecord): void {
		if (!Value.Check(runSchema, run)) throw new Error("Invalid subagent run record");
		writeJsonFileDurable(this.runPath(run.sessionId, run.runId), run, 0o600);
	}

	readRun(sessionId: string, runId?: string): RunRecord {
		const metadata = this.read(sessionId);
		const id = runId ?? metadata.runId;
		if (!id || !Value.Check(sessionIdSchema, id)) throw new Error("Subagent run not found");
		const file = this.runPath(sessionId, id);
		if (!existsSync(file) || lstatSync(file).isSymbolicLink()) throw new Error("Subagent run not found");
		const value = readJsonFile(file);
		if (
			!Value.Check(runSchema, value) ||
			value.runId !== id ||
			value.sessionId !== sessionId ||
			!Number.isFinite(Date.parse(value.startedAt)) ||
			value.evidence.some((item) => !Number.isFinite(Date.parse(item.observedAt))) ||
			value.proposals?.some((proposal) => !extractProposedOrder(proposal))
		)
			throw new Error("Invalid subagent run record");
		if (value.report) parseReport(value.report, value.evidence);
		return value as RunRecord;
	}

	list(limit = 20, offset = 0, agent?: string): { sessions: ChildSession[]; total: number } {
		if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0)
			throw new Error("Invalid subagent session page");
		const sessions = readdirSync(this.directory, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && Value.Check(sessionIdSchema, entry.name))
			.map((entry) => this.read(entry.name))
			.filter((session) => !agent || session.agent === agent)
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
		return { sessions: sessions.slice(offset, offset + limit), total: sessions.length };
	}
}
