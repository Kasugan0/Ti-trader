import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evidenceRuntime } from "../__tests__/evidence-fixture.ts";
import type { PlanContent } from "./model.ts";
import { planIndex } from "./runtime.ts";
import { PlanStore } from "./store.ts";

let root: string;
const planContent = (now: number): PlanContent => ({
	symbol: "BTC/USDT",
	timeframe: "1h",
	direction: "observe",
	thesis: "Original rationale",
	entry: [{ fact: "price", operator: "gt", value: 100 }],
	invalidation: [{ fact: "price", operator: "lt", value: 90 }],
	expiresAt: new Date(now + 86_400_000).toISOString(),
	reviewAt: new Date(now + 3_600_000).toISOString(),
	risk: "No execution",
	evidence: [{ source: "offline fixture", observedAt: new Date(now).toISOString(), summary: "Recorded observation" }],
});
beforeEach(() => {
	root = mkdtempSync(join(realpathSync(tmpdir()), "ti-plan-recovery-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("offline plan recovery exercises", () => {
	it("serializes separate-process revisions and preserves both writers' appended notes", async () => {
		const f = evidenceRuntime();
		const store = new PlanStore(root);
		const now = Date.now();
		const content = planContent(now);
		const plan = store.create(f.scope, content);
		const run = (writer: string, action: "revise" | "notes") =>
			new Promise<string>((done, reject) => {
				const child = spawn(
					process.execPath,
					[
						"--import",
						"tsx",
						resolve("src/__tests__/fixtures/plan-store-worker.ts"),
						root,
						plan.id,
						JSON.stringify(f.scope),
						writer,
						action,
					],
					{
						cwd: resolve("../.."),
						env: { PATH: process.env.PATH, TI_DATA_DIR: root },
						stdio: ["ignore", "pipe", "pipe"],
					},
				);
				let output = "";
				let errors = "";
				child.stdout.on("data", (data: Buffer) => {
					output += data.toString();
				});
				child.stderr.on("data", (data: Buffer) => {
					errors += data.toString();
				});
				child.on("error", reject);
				child.on("exit", (code) => (code === 0 ? done(output) : reject(new Error(errors))));
			});
		expect((await Promise.all([run("first", "revise"), run("second", "revise")])).sort()).toEqual([
			"conflict",
			"revised",
		]);
		await Promise.all([run("first", "notes"), run("second", "notes")]);
		const restored = new PlanStore(root).read(plan.id, f.scope);
		expect(restored.versions).toHaveLength(2);
		expect(restored.versions[0].content.thesis).toBe(content.thesis);
		expect(new Set(restored.notes.map((note) => note.text)).size).toBe(20);
		expect(f.placeOrder).not.toHaveBeenCalled();
	}, 30_000);

	it("restores a stopped-writer backup privately, rejects future formats, and never rewrites corrupt data", () => {
		const f = evidenceRuntime();
		const store = new PlanStore(root);
		const plan = store.create(f.scope, planContent(Date.now()));
		store.activate(plan.id, f.scope, 1);
		store.note(plan.id, f.scope, "Retained operator research", "operator");
		const backup = readFileSync(store.storage.path);
		const restoredRoot = join(root, "restored");
		mkdirSync(join(restoredRoot, "plans"), { recursive: true, mode: 0o700 });
		copyFileSync(store.storage.path, join(restoredRoot, "plans", "state.json"));
		const restored = new PlanStore(restoredRoot);
		expect(restored.read(plan.id, f.scope)).toMatchObject({
			activeVersion: 1,
			status: "tracking",
			notes: [{ author: "operator", text: "Retained operator research" }],
		});
		expect(planIndex(restored, f.scope)).toContain("non-authoritative");
		const unknown = JSON.stringify({ version: 2, epochs: {}, plans: [] });
		writeFileSync(restored.storage.path, unknown);
		expect(() => restored.storage.transact(() => {})).toThrow(/Invalid plan state/);
		expect(readFileSync(restored.storage.path, "utf8")).toBe(unknown);
		writeFileSync(restored.storage.path, backup);
		expect(restored.storage.read()).toEqual(store.storage.read());
	});
});
