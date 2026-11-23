import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

test("the attached display and request card load without the Slop executor or store", async () => {
	const forbidden = new Set(
		["index", "durable", "operations", "store", "settings", "input"].map(
			(name) => new URL(`./${name}.ts`, import.meta.url).href,
		),
	);
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			const result = nextResolve(specifier, context);
			assert.ok(!forbidden.has(result.url), `Presentation imported ${result.url} from ${context.parentURL}`);
			return result;
		},
	});
	try {
		const { toolDisplay } = await import("./display.ts");
		const { renderCheckRequest } = await import("./check-request.ts");
		assert.equal(typeof toolDisplay, "function");
		assert.equal(typeof renderCheckRequest, "function");
	} finally {
		hook.deregister();
	}
});
