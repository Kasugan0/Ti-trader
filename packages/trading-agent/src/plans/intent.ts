import { createHash } from "node:crypto";

export function canonicalPlanValue(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalPlanValue).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalPlanValue(item)}`)
			.join(",")}}`;
	}
	throw new Error("Invalid plan submission value");
}

export function normalizedPlanIntent(intent: {
	kind: "order" | "oco";
	input: Record<string, unknown>;
	replacementIds?: string[];
}): string {
	if (intent.kind === "order") {
		const { clientOrderId: _clientOrderId, ...input } = intent.input;
		return canonicalPlanValue({ ...intent, input });
	}
	const {
		listClientOrderId: _listClientOrderId,
		aboveClientOrderId: _aboveClientOrderId,
		belowClientOrderId: _belowClientOrderId,
		...input
	} = intent.input;
	return canonicalPlanValue({ ...intent, input });
}

function isPlanIntent(value: unknown): value is {
	kind: "order" | "oco";
	input: Record<string, unknown>;
	replacementIds?: string[];
} {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (record.kind !== "order" && record.kind !== "oco") return false;
	if (record.input === null || typeof record.input !== "object" || Array.isArray(record.input)) return false;
	if (record.replacementIds === undefined) return true;
	return Array.isArray(record.replacementIds) && record.replacementIds.every((id) => typeof id === "string");
}

export function planIntentIdentity(descriptor: unknown): {
	intent: string;
	countTowardsDailyLimit: unknown;
	protectionStopPrice?: unknown;
} {
	if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
		throw new Error("Invalid plan submission value");
	}
	const record = descriptor as Record<string, unknown>;
	if (!isPlanIntent(record.intent)) throw new Error("Invalid plan submission value");
	return {
		intent: normalizedPlanIntent(record.intent),
		countTowardsDailyLimit: record.countTowardsDailyLimit,
		...(record.protectionStopPrice === undefined ? {} : { protectionStopPrice: record.protectionStopPrice }),
	};
}

export function planIntentFingerprint(descriptor: unknown): string {
	return createHash("sha256")
		.update(canonicalPlanValue(planIntentIdentity(descriptor)))
		.digest("hex");
}
