import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
	const dir = `${process.env.TMPDIR ?? "/tmp"}/ti-keys-permissions-${process.pid}-${Date.now()}`;
	return { dir, keysPath: `${dir}/keys.json` };
});

vi.mock("../config.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../config.ts")>();
	return { ...actual, KEYS_PATH: fixture.keysPath };
});

import { loadExchangeKeyEntry, loadExchangeKeys, mutateExchangeKeys } from "../state.ts";

afterAll(() => {
	rmSync(fixture.dir, { recursive: true, force: true });
});

describe("exchange keys file permissions", () => {
	it("tightens a group/world-readable keys file to 600 before reading", () => {
		mkdirSync(fixture.dir, { recursive: true });
		writeFileSync(fixture.keysPath, JSON.stringify({ binance: { apiKey: "k", secret: "s" } }), { mode: 0o644 });
		chmodSync(fixture.keysPath, 0o644);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const keys = loadExchangeKeys();
			expect(keys.binance?.apiKey).toBe("k");
			expect(statSync(fixture.keysPath).mode & 0o777).toBe(0o600);
			expect(error).toHaveBeenCalledWith(expect.stringContaining("permissions tightened"));
		} finally {
			error.mockRestore();
		}
	});

	it("leaves an owner-only keys file untouched", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const keys = loadExchangeKeys();
			expect(keys.binance?.secret).toBe("s");
			expect(statSync(fixture.keysPath).mode & 0o777).toBe(0o600);
			expect(error).not.toHaveBeenCalled();
		} finally {
			error.mockRestore();
		}
	});

	it("returns empty credentials when no keys file exists", () => {
		rmSync(fixture.keysPath, { force: true });
		expect(loadExchangeKeys()).toEqual({});
	});
});

describe("mutateExchangeKeys", () => {
	it("merges entries stored by another session instead of overwriting them", () => {
		mkdirSync(fixture.dir, { recursive: true });
		writeFileSync(
			fixture.keysPath,
			JSON.stringify({ binance: { apiKey: "binance-key", secret: "binance-secret" } }),
			{ mode: 0o600 },
		);
		mutateExchangeKeys((keys) => {
			keys.okx = { apiKey: "okx-key", secret: "okx-secret", password: "pass" };
		});
		expect(loadExchangeKeys()).toEqual({
			binance: { apiKey: "binance-key", secret: "binance-secret" },
			okx: { apiKey: "okx-key", secret: "okx-secret", password: "pass" },
		});
		expect(statSync(fixture.keysPath).mode & 0o777).toBe(0o600);
	});

	it("leaves the stored file unchanged when the mutator fails", () => {
		writeFileSync(
			fixture.keysPath,
			JSON.stringify({ binance: { apiKey: "binance-key", secret: "binance-secret" } }),
			{ mode: 0o600 },
		);
		expect(() =>
			mutateExchangeKeys((keys) => {
				keys.okx = { apiKey: "okx-key", secret: "okx-secret" };
				throw new Error("mutator failed");
			}),
		).toThrow("mutator failed");
		expect(loadExchangeKeys()).toEqual({ binance: { apiKey: "binance-key", secret: "binance-secret" } });
	});

	it("rejects empty credentials before writing", () => {
		rmSync(fixture.keysPath, { force: true });
		expect(() =>
			mutateExchangeKeys((keys) => {
				keys.okx = { apiKey: "  ", secret: "okx-secret" };
			}),
		).toThrow("Credentials for okx must include apiKey and secret");
		expect(existsSync(fixture.keysPath)).toBe(false);
	});
});

describe("loadExchangeKeyEntry", () => {
	it("returns the target exchange credentials without validating other entries", () => {
		mkdirSync(fixture.dir, { recursive: true });
		writeFileSync(
			fixture.keysPath,
			JSON.stringify({ binance: { apiKey: "k", secret: "s" }, corrupt: "not-an-object" }),
			{ mode: 0o600 },
		);
		expect(loadExchangeKeyEntry("binance")).toEqual({ apiKey: "k", secret: "s" });
	});

	it("returns undefined when the target exchange has no entry", () => {
		writeFileSync(fixture.keysPath, JSON.stringify({ binance: { apiKey: "k", secret: "s" } }), {
			mode: 0o600,
		});
		expect(loadExchangeKeyEntry("okx")).toBeUndefined();
	});

	it("rejects a malformed target entry", () => {
		writeFileSync(fixture.keysPath, JSON.stringify({ okx: { secret: "s" } }), { mode: 0o600 });
		expect(() => loadExchangeKeyEntry("okx")).toThrow("Credentials for okx must include non-empty apiKey and secret");
	});
});
