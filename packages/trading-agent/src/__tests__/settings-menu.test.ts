import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLiveVenue } from "../../../trading-engine/src/venues/index.ts";

const stateMocks = vi.hoisted(() => {
	const saved: Array<Record<string, unknown>> = [];
	return {
		loadExchangeKeys: vi.fn(() => ({})),
		loadExchangeKeyEntry: vi.fn(() => undefined),
		mutateExchangeKeys: vi.fn((mutator: (keys: Record<string, unknown>) => unknown) => {
			const keys: Record<string, unknown> = {};
			mutator(keys);
			saved.push(keys);
		}),
		saved,
	};
});
const venueMocks = vi.hoisted(() => ({
	resolveLiveVenue: vi.fn(),
}));

vi.mock("../state.ts", () => stateMocks);

vi.mock("@nikopack/ti-trading-engine", () => venueMocks);

import { loginExchange } from "../settings-menu.ts";

describe("loginExchange", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		stateMocks.saved.length = 0;
		venueMocks.resolveLiveVenue.mockImplementation(resolveLiveVenue);
	});

	it("masks every exchange credential input", async () => {
		const input = vi
			.fn<NonNullable<ExtensionCommandContext["ui"]>["input"]>()
			.mockResolvedValueOnce("api-key")
			.mockResolvedValueOnce("api-secret");
		const notify = vi.fn();
		const ctx = { ui: { input, notify } } as unknown as ExtensionCommandContext;

		await loginExchange("binance", ctx);

		for (const call of input.mock.calls) {
			expect(call[2]).toEqual({ secret: true });
		}
		expect(input).toHaveBeenCalledTimes(2);
		expect(stateMocks.saved).toEqual([{ binance: { apiKey: "api-key", secret: "api-secret" } }]);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Keys for binance saved"), "info");
	});

	it("requires an OKX passphrase and does not save empty credentials", async () => {
		const input = vi
			.fn<NonNullable<ExtensionCommandContext["ui"]>["input"]>()
			.mockResolvedValueOnce("api-key")
			.mockResolvedValueOnce("api-secret")
			.mockResolvedValueOnce("   ");
		const notify = vi.fn();
		const ctx = { ui: { input, notify } } as unknown as ExtensionCommandContext;

		await loginExchange("okx", ctx);

		expect(input).toHaveBeenCalledTimes(3);
		expect(stateMocks.saved).toEqual([]);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("passphrase is required"), "warning");
	});

	it("saves an OKX passphrase", async () => {
		const input = vi
			.fn<NonNullable<ExtensionCommandContext["ui"]>["input"]>()
			.mockResolvedValueOnce("api-key")
			.mockResolvedValueOnce("api-secret")
			.mockResolvedValueOnce("passphrase");
		const notify = vi.fn();
		const ctx = { ui: { input, notify } } as unknown as ExtensionCommandContext;

		await loginExchange("okx", ctx);

		expect(stateMocks.saved).toEqual([{ okx: { apiKey: "api-key", secret: "api-secret", password: "passphrase" } }]);
	});
});
