import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireFileLockSync, readJsonFile, releaseFileLock, withFileLockSync, writeJsonFile } from "./persist.ts";

describe("persist", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ti-persist-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("round-trips JSON through an atomic write", () => {
		const path = join(dir, "state.json");
		writeJsonFile(path, { quote: "USDT", value: 1 });
		expect(readJsonFile(path)).toEqual({ quote: "USDT", value: 1 });
	});

	it("returns undefined when the JSON file is absent", () => {
		expect(readJsonFile(join(dir, "missing.json"))).toBeUndefined();
	});

	it("throws SyntaxError for invalid JSON", () => {
		const path = join(dir, "broken.json");
		writeFileSync(path, "{");
		expect(() => readJsonFile(path)).toThrow(SyntaxError);
	});

	it("times out with a custom lock message", () => {
		const lockPath = join(dir, "state.lock");
		writeFileSync(lockPath, "");
		expect(() =>
			acquireFileLockSync(lockPath, {
				timeoutMs: 30,
				staleMs: 60_000,
				timeoutMessage: (path) => `Timed out waiting for paper account lock ${path}`,
			}),
		).toThrow(`Timed out waiting for paper account lock ${lockPath}`);
	});

	it("reclaims a stale lock without waiting for the timeout and removes the reclaim gate", () => {
		const lockPath = join(dir, "state.lock");
		writeFileSync(lockPath, "");
		const past = new Date(Date.now() - 120_000);
		utimesSync(lockPath, past, past);
		const lock = acquireFileLockSync(lockPath, { timeoutMs: 200, staleMs: 60_000 });
		expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
		releaseFileLock(lock);
	});

	it("serializes stale reclamation so a replacement lock survives", () => {
		const lockPath = join(dir, "state.lock");
		const gatePath = `${lockPath}.reclaim`;
		writeFileSync(lockPath, JSON.stringify({ pid: 999_999, host: "other-host" }));
		const past = new Date(Date.now() - 120_000);
		utimesSync(lockPath, past, past);

		// Simulate another process mid-reclamation holding the gate: a waiter
		// must not unlink the stale lock file while that reclaimer is in flight.
		writeFileSync(gatePath, "");
		expect(() => acquireFileLockSync(lockPath, { timeoutMs: 100, staleMs: 60_000 })).toThrow("Timed out");
		expect(existsSync(lockPath)).toBe(true);

		// The other reclaimer replaces the stale lock with a fresh one, then
		// releases the gate.
		rmSync(gatePath);
		rmSync(lockPath);
		const replacement = acquireFileLockSync(lockPath, { timeoutMs: 200 });

		// A new waiter sees a non-stale lock: it must leave the replacement in
		// place instead of unlinking the lock another process still holds.
		expect(() => acquireFileLockSync(lockPath, { timeoutMs: 100, staleMs: 60_000 })).toThrow("Timed out");
		expect(statSync(lockPath).ino).toBe(replacement.inode);
		releaseFileLock(replacement);
		expect(existsSync(lockPath)).toBe(false);
	});

	it("prefers the operation error when the locked callback throws", () => {
		const lockPath = join(dir, "state.lock");
		expect(() =>
			withFileLockSync(lockPath, () => {
				throw new Error("mutator failed");
			}),
		).toThrow("mutator failed");
		const lock = acquireFileLockSync(lockPath, { timeoutMs: 200 });
		releaseFileLock(lock);
	});

	it("never takes over a live owner by age, but recovers a verified dead local owner", () => {
		const path = join(dir, "owned.lock");
		const lock = acquireFileLockSync(path, { staleMs: Infinity, reclaimDeadOwner: true });
		const past = new Date(Date.now() - 120_000);
		utimesSync(path, past, past);
		expect(() => acquireFileLockSync(path, { timeoutMs: 20, staleMs: Infinity, reclaimDeadOwner: true })).toThrow(
			"Timed out",
		);
		const owner = readJsonFile(path);
		if (!owner || typeof owner !== "object" || !("pid" in owner)) throw new Error("Owner metadata missing");
		const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
		expect(child.status).toBe(0);
		owner.pid = child.pid;
		writeJsonFile(path, owner);
		const recovered = acquireFileLockSync(path, { timeoutMs: 200, staleMs: Infinity, reclaimDeadOwner: true });
		releaseFileLock(lock);
		releaseFileLock(recovered);
	});
});
