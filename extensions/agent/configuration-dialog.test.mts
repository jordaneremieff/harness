import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configurationDialog } from "./configuration-dialog.ts";
import { row } from "./dashboard-test-fixture.mts";

it("Escape from the model picker returns to the completed search before the fields", async () => {
	const selections: Array<string | undefined> = ["Model", undefined, "Cancel"];
	const inputs: Array<string | undefined> = ["test", undefined];
	const searches: Array<{ title: string; placeholder?: string }> = [];
	const ctx = {
		modelRegistry: { getAvailable: () => [{ provider: "test", id: "model" }] },
		ui: {
			select: async () => selections.shift(),
			input: async (title: string, placeholder?: string) => {
				searches.push({ title, placeholder });
				return inputs.shift();
			},
			notify() {},
		},
	} as unknown as ExtensionContext;
	assert.equal(await configurationDialog(row(), ctx), undefined);
	assert.equal(searches.length, 2);
	assert.match(searches[1]?.title ?? "", /test.*blank keeps/);
	assert.equal(inputs.length, 0);
});
it("reasoning and model pickers start with the completed field value", async () => {
	const selections = ["Reasoning", "medium", "Reasoning", undefined, "Model", "test/model", "Cancel"];
	const options: Array<{ title: string; choices: string[] }> = [];
	const ctx = {
		modelRegistry: {
			getAvailable: () => [
				{ provider: "a", id: "first" },
				{ provider: "test", id: "model" },
			],
		},
		ui: {
			select: async (title: string, choices: string[]) => {
				options.push({ title, choices });
				return selections.shift();
			},
			input: async () => "",
			notify() {},
		},
	} as unknown as ExtensionContext;
	assert.equal(await configurationDialog(row(), ctx), undefined);
	const reasoning = options.filter((call) => call.title.startsWith("Reasoning level"));
	assert.equal(reasoning[0]?.choices[0], "high");
	assert.equal(reasoning[1]?.choices[0], "medium");
	assert.equal(options.find((call) => call.title.startsWith("Model ("))?.choices[0], "test/model");
});
