import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMarketResearchTool } from "../subagent/index.ts";

export default function marketResearchExtension(pi: ExtensionAPI): void {
	registerMarketResearchTool(pi);
}
