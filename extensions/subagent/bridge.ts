import { Type } from "typebox";
import { Value } from "typebox/value";
import {
	asRecord,
	CANDLE_PROVIDER_KEY,
	type CandleProvider,
	EVIDENCE_BYTES,
	LAB_TOOLS,
	type ResearchRuntime,
	type ResearchTool,
} from "./protocol.ts";

const candleSchema = Type.Object(
	{
		symbol: Type.String({ minLength: 3, maxLength: 64 }),
		timeframe: Type.String({ pattern: "^[1-9][0-9]*[mhdw]$", maxLength: 4 }),
		limit: Type.Integer({ minimum: 20, maximum: 200 }),
	},
	{ additionalProperties: false },
);

export class ResearchAccess {
	readonly snapshotAt = new Date().toISOString();
	readonly scope: string;
	readonly tools: ResearchTool[];
	private readonly runtime: ResearchRuntime | undefined;
	private readonly signal: AbortSignal | undefined;
	private readonly candles = new Map<string, Promise<unknown>>();

	constructor(runtime?: ResearchRuntime, signal?: AbortSignal) {
		this.runtime = runtime;
		this.signal = signal;
		this.scope = runtime?.scope() ?? "binance-public-spot";
		this.tools = runtime?.tools() ?? [];
	}

	available(): string[] {
		const hasCandles = typeof (globalThis as Record<PropertyKey, unknown>)[CANDLE_PROVIDER_KEY] === "function";
		return this.runtime
			? [...new Set([...this.tools.map((tool) => tool.name), ...(hasCandles ? LAB_TOOLS : [])])]
			: [...LAB_TOOLS];
	}

	assertCurrent(): void {
		if (this.runtime && this.runtime.scope() !== this.scope)
			throw new Error("Research account/market scope changed; start a new invocation");
	}

	async call(name: string, args: unknown, allowed: readonly string[], signal: AbortSignal): Promise<unknown> {
		signal.throwIfAborted();
		this.assertCurrent();
		if (name === "__candles") {
			if (!allowed.some((tool) => (LAB_TOOLS as readonly string[]).includes(tool)))
				throw new Error("This specialist cannot request candles");
			if (!this.runtime) throw new Error("Session candle bridge unavailable");
			if (!Value.Check(candleSchema, args)) throw new Error("Invalid child candle request");
			const request = args as { symbol: string; timeframe: string; limit: number };
			const key = JSON.stringify([request.symbol.toUpperCase(), request.timeframe, request.limit]);
			let cached = this.candles.get(key);
			if (!cached) {
				const provider = (globalThis as Record<PropertyKey, unknown>)[CANDLE_PROVIDER_KEY];
				if (typeof provider !== "function") throw new Error("Session candle bridge unavailable");
				cached = (provider as CandleProvider)({ ...request, signal: this.signal }).then((value) => {
					this.assertCurrent();
					const data = asRecord(value);
					const source = asRecord(data?.source);
					if (!Array.isArray(data?.candles) || source?.kind !== "session-klines")
						throw new Error("Session candle bridge returned non-session data");
					const units: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
					const duration = Number(request.timeframe.slice(0, -1)) * units[request.timeframe.slice(-1)];
					const cutoff = Date.parse(this.snapshotAt);
					return {
						...data,
						candles: data.candles.filter((candle: unknown) => {
							const row = asRecord(candle);
							if (typeof row?.timestamp !== "number") throw new Error("Invalid session candle timestamp");
							return row.timestamp + duration <= cutoff;
						}),
						source: { ...source, snapshotAt: this.snapshotAt },
					};
				});
				this.candles.set(key, cached);
			}
			const value = await new Promise<unknown>((resolve, reject) => {
				const abort = (): void => reject(new Error("Research candle request cancelled"));
				signal.addEventListener("abort", abort, { once: true });
				cached.then(
					(value) => {
						signal.removeEventListener("abort", abort);
						resolve(value);
					},
					(error) => {
						signal.removeEventListener("abort", abort);
						reject(error);
					},
				);
				if (signal.aborted) abort();
			});
			signal.throwIfAborted();
			this.assertCurrent();
			return value;
		}
		if (!allowed.includes(name)) throw new Error(`Specialist tool is not allowed: ${name}`);
		const tool = this.tools.find((tool) => tool.name === name);
		if (!this.runtime || !tool) throw new Error(`Research tool is unavailable: ${name}`);
		if (!Value.Check(tool.parameters, args)) throw new Error(`Invalid ${name} arguments`);
		const result = await this.runtime.execute(name, args, signal);
		signal.throwIfAborted();
		this.assertCurrent();
		if (result.isError) throw new Error(`Research tool failed: ${name}`);
		if (Buffer.byteLength(JSON.stringify(result), "utf8") > EVIDENCE_BYTES)
			throw new Error(`Research tool output exceeds ${EVIDENCE_BYTES} bytes: ${name}`);
		return result;
	}
}
