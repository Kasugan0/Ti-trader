import { type Static, Type } from "typebox";
import { planPage } from "../plans/presentation.ts";
import type { evaluateActualExecutions } from "./evaluation.ts";
import type { DecisionTurn, evaluateDecisions } from "./evidence.ts";

export const evaluationSectionSchema = Type.Union([
	Type.Literal("overview"),
	Type.Literal("discipline"),
	Type.Literal("strategy"),
	Type.Literal("samples"),
	Type.Literal("executions"),
	Type.Literal("protocols"),
]);
type Evaluation = ReturnType<typeof evaluateDecisions> & {
	actualExecution: ReturnType<typeof evaluateActualExecutions>;
	evaluatedAt?: string;
};
export type EvaluationSection = Static<typeof evaluationSectionSchema>;

export function decisionEvaluationPage(report: Evaluation, section: EvaluationSection = "overview", offset = 0) {
	const cohorts = report.strategy.cohorts.map(({ sampleResults, ...cohort }) => ({
		...cohort,
		sampleResultCount: sampleResults.length,
	}));
	if (section !== "overview") {
		const entries: unknown[] =
			section === "discipline"
				? report.cohorts
				: section === "strategy"
					? cohorts
					: section === "executions"
						? report.actualExecution.rows
						: section === "protocols"
							? report.strategy.protocols
							: report.strategy.cohorts.flatMap((cohort) => cohort.sampleResults);
		return { section, ...planPage(entries, offset, "/decisions export") };
	}
	const { cohorts: _cohorts, protocols, ...strategy } = report.strategy;
	const { rows, ...actualExecution } = report.actualExecution;
	return {
		kind: report.kind,
		version: report.version,
		evaluatedAt: report.evaluatedAt ?? null,
		discipline: report.discipline,
		runtimeReadiness: report.runtimeReadiness,
		tradingAuthority: report.tradingAuthority,
		strategy: { ...strategy, cohortCount: cohorts.length, protocolCount: protocols.length },
		actualExecution: { ...actualExecution, recordCount: rows.length },
		counts: {
			disciplineCohorts: report.cohorts.length,
			strategyCohorts: cohorts.length,
			samples: report.strategy.cohorts.reduce((sum, cohort) => sum + cohort.samples, 0),
			executions: rows.length,
		},
		sections: ["discipline", "strategy", "samples", "executions", "protocols"],
		limitations: report.limitations,
	};
}

export function decisionTurnPage(turn: DecisionTurn, offset = 0) {
	const { observations, claims, mutations, ...identity } = turn;
	const entries = [
		...observations.map((entry) => ({ kind: "observation", ...entry })),
		...claims.map((entry) => ({ kind: "claim", ...entry })),
		...mutations.map((entry) => ({ kind: "mutation", ...entry })),
	].sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
	return { ...identity, ...planPage(entries, offset, "/decisions export") };
}
