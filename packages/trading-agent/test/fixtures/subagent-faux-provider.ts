import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "../../../ai/src/providers/faux.ts";

export default function subagentFauxProvider(pi: ExtensionAPI): void {
	const faux = createFauxCore({
		provider: "ti-subagent-test",
		api: "ti-subagent-test",
		models: [{ id: "offline", contextWindow: 128000, maxTokens: 4000 }],
	});
	faux.setResponses(
		Array.from({ length: 8 }, () => (context) => {
			const users = context.messages.filter((message) => message.role === "user");
			const lastUserIndex = context.messages.map((message) => message.role).lastIndexOf("user");
			const results = context.messages.slice(lastUserIndex + 1).filter((message) => message.role === "toolResult");
			if (results.length === 0) {
				return fauxAssistantMessage(
					fauxToolCall("calculate_indicators", { symbol: "BTC/USDT:USDT", timeframe: "1h", limit: 100 }),
					{ stopReason: "toolUse" },
				);
			}
			const latest = results.at(-1)!;
			if (latest.isError) throw new Error(`Fixture research tool failed: ${JSON.stringify(latest.content)}`);
			const reference = latest.content.find((part) => part.type === "text" && part.text.includes('"evidence"'));
			if (!reference || reference.type !== "text") throw new Error("Fixture expected an evidence reference");
			const parsed = JSON.parse(reference.text) as { evidence: { id: string } };
			return fauxAssistantMessage(
				fauxToolCall("finish_analysis", {
					summary: `users=${users.length}; remembers-first=${JSON.stringify(users).includes("first-marker")}; secret-visible=${Boolean(process.env.TI_TEST_EXCHANGE_KEY)}`,
					findings: [{ claim: "Session futures indicators were observed", evidenceIds: [parsed.evidence.id] }],
					risks: ["Fixture data only"],
					invalidation: [],
					unknowns: ["No execution authorization"],
					bias: "none",
				}),
				{ stopReason: "toolUse" },
			);
		}),
	);
	pi.registerProvider("ti-subagent-test", {
		baseUrl: "http://localhost:0",
		api: faux.api,
		apiKey: "offline-fixture-only",
		models: faux.models,
		streamSimple: faux.streamSimple,
	});
}
