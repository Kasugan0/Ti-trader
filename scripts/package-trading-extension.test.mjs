import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPublishedManifest, packageTradingExtension } from "./package-trading-extension.mjs";

test("published extension manifests point to the compiled entry", () => {
	const sourceManifest = {
		name: "example-extension",
		pi: { extensions: ["./index.ts"], skills: ["./SKILL.md"] },
		ti: { extensions: ["./index.ts"] },
	};

	assert.deepEqual(createPublishedManifest(sourceManifest), {
		name: "example-extension",
		pi: { extensions: ["./index.js"], skills: ["./SKILL.md"] },
		ti: { extensions: ["./index.js"] },
	});
	assert.deepEqual(sourceManifest.pi.extensions, ["./index.ts"]);
});

test("packages shared-runtime extensions from nested TypeScript output", () => {
	const root = mkdtempSync(join(tmpdir(), "ti-extension-packaging-"));
	try {
		const source = join(root, "extensions", "market-research");
		const compiled = join(source, "dist", "market-research");
		mkdirSync(compiled, { recursive: true });
		writeFileSync(join(source, "package.json"), JSON.stringify({ name: "fixture", pi: { extensions: ["./index.ts"] } }));
		writeFileSync(join(compiled, "index.js"), 'export { default } from "../subagent/index.js";');
		packageTradingExtension("market-research", root);
		const target = join(root, "packages", "trading-agent", "dist", "market-research");
		assert.equal(readFileSync(join(target, "index.js"), "utf8"), 'export { default } from "../subagent/index.js";');
		assert.deepEqual(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).pi.extensions, ["./index.js"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
