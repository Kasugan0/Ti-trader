/**
 * Discover Ti subagent definitions and keep their tools inside the
 * read-only market-lab allowlist.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { type AnalysisBudget, analysisBudgetSchema, LAB_TOOLS, READ_ONLY_TOOLS } from "./protocol.ts";

export const ALLOWED_CHILD_TOOLS = [...READ_ONLY_TOOLS, "propose_order"] as const;
export const DEFAULT_CHILD_TOOLS = [...LAB_TOOLS, "propose_order"];
export const DEFAULT_BUDGET: AnalysisBudget = {};

const ALLOWED_CHILD_TOOL_SET = new Set<string>(ALLOWED_CHILD_TOOLS);

export const PROJECT_CONFIG_DIR_NAME = ".ti-trader";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "bundled" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	budget?: AnalysisBudget;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	timeoutMs?: unknown;
	maxTurns?: unknown;
	maxToolCalls?: unknown;
	maxTokens?: unknown;
};

export function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

export function resolveChildTools(requested: string[] | undefined): { tools: string[]; rejected: string[] } {
	if (requested === undefined) return { tools: [...DEFAULT_CHILD_TOOLS], rejected: [] };
	const tools: string[] = [];
	const rejected: string[] = [];
	const seen = new Set<string>();
	for (const name of requested) {
		if (seen.has(name)) continue;
		seen.add(name);
		if (ALLOWED_CHILD_TOOL_SET.has(name)) tools.push(name);
		else rejected.push(name);
	}
	return { tools, rejected };
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	const entries = fs
		.readdirSync(dir, { withFileTypes: true })
		.sort((left, right) => left.name.localeCompare(right.name));

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		const content = fs.readFileSync(filePath, "utf-8");

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
		if (
			typeof frontmatter.name !== "string" ||
			!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(frontmatter.name) ||
			typeof frontmatter.description !== "string" ||
			frontmatter.description.trim().length === 0 ||
			frontmatter.description.length > 500
		)
			throw new Error(`Invalid subagent name or description: ${filePath}`);
		const budget = { ...DEFAULT_BUDGET };
		for (const key of ["timeoutMs", "maxTurns", "maxToolCalls", "maxTokens"] as const) {
			if (frontmatter[key] === undefined) continue;
			const raw = frontmatter[key];
			const value = typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw)) ? Number(raw) : NaN;
			if (!Value.Check(analysisBudgetSchema.properties[key], value))
				throw new Error(
					`Invalid subagent ${key} in ${filePath}; omit for unlimited or use a positive integer within the supported numeric range`,
				);
			budget[key] = value;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			budget,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

export function findNearestProjectAgentsDir(cwd: string, configDirName = PROJECT_CONFIG_DIR_NAME): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, configDirName, "agents");
		if (isDirectory(candidate)) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(input: {
	cwd: string;
	scope: AgentScope;
	bundledDir: string;
	userDir: string;
	projectConfigDirName?: string;
}): AgentDiscoveryResult {
	const projectAgentsDir = findNearestProjectAgentsDir(input.cwd, input.projectConfigDirName);
	const bundled = loadAgentsFromDir(input.bundledDir, "bundled");
	const userAgents = input.scope === "project" ? [] : loadAgentsFromDir(input.userDir, "user");
	const projectAgents =
		input.scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();
	for (const agent of bundled) agentMap.set(agent.name, agent);
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	for (const agent of projectAgents) agentMap.set(agent.name, agent);

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("; "),
		remaining,
	};
}
