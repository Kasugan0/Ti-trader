import { Check } from "typebox/value";
import { scopeSchema } from "../../plans/model.ts";
import { PlanStore } from "../../plans/store.ts";

const [root, id, encodedScope, writer, action] = process.argv.slice(2);
const scope: unknown = JSON.parse(encodedScope);
if (!Check(scopeSchema, scope)) throw new Error("Invalid fixture scope");
const store = new PlanStore(root);
if (action === "revise") {
	const plan = store.read(id, scope);
	try {
		store.revise(id, scope, 1, { ...plan.versions[0].content, thesis: writer });
		process.stdout.write("revised");
	} catch (error) {
		if (!(error instanceof Error) || !error.message.includes("revision conflict")) throw error;
		process.stdout.write("conflict");
	}
} else if (action === "notes") {
	for (let index = 0; index < 10; index++) store.note(id, scope, `${writer}-${index}`);
} else {
	throw new Error("Invalid fixture action");
}
