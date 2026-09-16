import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	type ExchangeClient,
	type Order,
	type PlaceOrderInput,
	TradingEngine,
	type TradingRiskState,
} from "@nikopack/ti-trading-engine";
import { Check } from "typebox/value";
import { vi } from "vitest";
import type { TradingRuntime } from "../context.ts";
import { DEFAULT_CONFIG } from "../state.ts";

export function evidenceRuntime(mode: "paper" | "live" = "paper") {
	const config = { ...structuredClone(DEFAULT_CONFIG), mode, exchange: "binance" };
	let state: TradingRiskState = {
		paper: { date: new Date().toISOString().slice(0, 10), usedDailyNotional: 0 },
		live: { date: new Date().toISOString().slice(0, 10), usedDailyNotional: 0 },
	};
	let orderIndex = 0;
	const placeOrder = vi.fn<ExchangeClient["placeOrder"]>(async (input: PlaceOrderInput) => ({
		order: {
			...input,
			id: `native-${++orderIndex}`,
			filled: input.amount,
			remaining: 0,
			cost: input.amount * 100,
			status: "closed" as const,
			timestamp: Date.now(),
			feeObservation: {
				source: mode === "paper" ? "paper-ledger" : "exchange",
				completeness: "complete",
				charges: [{ currency: "USDT", cost: 0.1 }],
			},
		},
		fee: 0.1,
	}));
	const unsupported = async (): Promise<never> => {
		throw new Error("Unsupported fixture operation");
	};
	const exchange: ExchangeClient = {
		id: "binance",
		mode,
		quoteCurrency: "USDT",
		placeOrder,
		getTicker: vi.fn(async (symbol) => ({
			symbol,
			last: 100,
			bid: 99,
			ask: 101,
			timestamp: Date.now(),
			sourceTimestampKnown: true,
		})),
		getKlines: vi.fn(async () => []),
		getMarketInfo: async (symbol) => ({
			symbol,
			base: "BTC",
			quote: "USDT",
			marketType: "spot",
			contract: false,
			active: true,
		}),
		getBalances: async () => [
			{ asset: "USDT", free: 10000, used: 0, total: 10000 },
			{ asset: "BTC", free: 10, used: 0, total: 10 },
		],
		getPositions: async () => [],
		getOpenOrders: async () => [],
		getOrderHistory: async () => [],
		getOrder: unsupported,
		getOrderByClientId: unsupported,
		getOrderList: unsupported,
		getOrderListByClientId: unsupported,
		placeOcoOrder: vi.fn(async (input) => ({
			orders: [input.aboveClientOrderId, input.belowClientOrderId].map(
				(clientOrderId, i): Order => ({
					symbol: input.symbol,
					side: input.side,
					type: "limit",
					amount: input.amount,
					id: `oco-${i}`,
					clientOrderId,
					listClientOrderId: input.listClientOrderId,
					orderListId: "list-1",
					filled: 0,
					remaining: input.amount,
					cost: 0,
					status: "open",
					timestamp: Date.now(),
				}),
			),
		})),
		cancelOrder: vi.fn(async () => {}),
		cancelOrderList: vi.fn(async () => {}),
		setLeverage: unsupported,
		setMarginMode: unsupported,
		setMultiAssetsMode: unsupported,
		getOrderBook: unsupported,
		getContractStats: unsupported,
		getTopMarkets: unsupported,
		getFundingRate: unsupported,
		getFundingRateHistory: unsupported,
		close: async () => {},
	};
	const engine = new TradingEngine(
		config,
		exchange,
		{
			load: () => structuredClone(state),
			save: (value) => {
				state = structuredClone(value);
			},
			transact: (operation) => {
				const next = structuredClone(state);
				const result = operation(next);
				state = next;
				return result;
			},
		},
		undefined,
		{ durability: "memory", accountId: "evidence-fixture" },
	);
	const runtime: Partial<TradingRuntime> = {
		config,
		mode,
		tradingEngine: engine,
		marketData: exchange,
		getExecutionScope: () => engine.getExecutionScope(),
	};
	return {
		runtime: runtime as TradingRuntime,
		config,
		exchange,
		engine,
		placeOrder,
		scope: engine.getExecutionScope(),
	};
}

export function evidenceExtensionHarness() {
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const tools = new Map<string, ToolDefinition>();
	const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
	const appendEntry = vi.fn<ExtensionAPI["appendEntry"]>();
	const api: Partial<ExtensionAPI> = {
		on: (event: string, handler: (event: never, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		registerTool: (tool) => {
			tools.set(tool.name, {
				name: tool.name,
				label: tool.label,
				description: tool.description,
				parameters: tool.parameters,
				execute: (id, params, signal, onUpdate, ctx) => {
					if (!Check(tool.parameters, params)) throw new Error("Invalid test tool parameters");
					return tool.execute(id, params, signal, onUpdate, ctx);
				},
			});
		},
		registerCommand: (
			name: string,
			command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) => commands.set(name, command),
		sendMessage,
		appendEntry,
		registerEntryRenderer: vi.fn(),
		getAllTools: () => [],
		getActiveTools: () => [...tools.keys()],
	};
	const confirm = vi.fn(async () => true);
	const notify = vi.fn();
	const ui: Partial<ExtensionCommandContext["ui"]> = { confirm, notify };
	const ctx: Partial<ExtensionCommandContext> = {
		hasUI: true,
		mode: "tui",
		ui: ui as ExtensionCommandContext["ui"],
		waitForIdle: async () => {},
	};
	return {
		api: api as ExtensionAPI,
		ctx: ctx as ExtensionCommandContext,
		tools,
		commands,
		sendMessage,
		appendEntry,
		confirm,
		notify,
		emit: (name: string, event: unknown = {}) => {
			const handler = handlers.get(name);
			if (!handler) throw new Error(`Missing handler ${name}`);
			return handler(event as never, ctx as ExtensionCommandContext);
		},
	};
}
