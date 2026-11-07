import assert from "node:assert/strict";
import { it } from "node:test";
import { renderDeclarations, renderToolOutputType, type CodemodeJsonSchema } from "@earendil-works/pi-codemode";
import { InspectToolOutputSchema, StatusOutputSchema, StatusToolOutputSchema } from "./observation-schema.ts";
import { ProfiledListOutputSchema } from "./profile-discovery.ts";

const SERIALIZED_STATUS_BYTES = 100_000;
const RENDERED_STATUS_CHARACTERS = 55_000;

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const rendered = (schema: object) => renderToolOutputType(schema as CodemodeJsonSchema);

it("keeps the tool status schema and its rendered declaration within their size budgets", () => {
	assert.ok(bytes(StatusToolOutputSchema) <= SERIALIZED_STATUS_BYTES, `serialized ${bytes(StatusToolOutputSchema)} bytes`);
	const declaration = rendered(StatusToolOutputSchema);
	assert.ok(declaration.length <= RENDERED_STATUS_CHARACTERS, `rendered ${declaration.length} characters`);
	const tools = renderDeclarations({ tools: [{ name: "agent_status", outputSchema: StatusToolOutputSchema as CodemodeJsonSchema, execute: async () => ({}) }] });
	assert.ok(tools.length <= RENDERED_STATUS_CHARACTERS + 1_000, `declared ${tools.length} characters`);
});

it("renders the status product as typed alternatives rather than unknown", () => {
	const declaration = rendered(StatusToolOutputSchema);
	assert.notEqual(declaration, "unknown");
	for (const field of ["conversation", "conversations", "inventory", "storageId", "attention", "awareness", "createdAgents", "sessions"]) {
		assert.match(declaration, new RegExp(`\\b${field}\\??:`, "u"), field);
	}
	assert.equal(declaration.split("lastTextRole").length - 1, 2, "conversation status renders once per payload shape");
	assert.equal(declaration.split("self:").length - 1, 1, "awareness renders once");
	assert.match(declaration, /"provider-blocked" \| "task-blocked" \| "failed-turn"|"failed-turn" \| "provider-blocked" \| "task-blocked"/u);
});

it("keeps the host status declaration separate from the tool status declaration", () => {
	assert.doesNotMatch(rendered(StatusOutputSchema), /attention\??: "provider-blocked"/u);
	assert.ok(rendered(InspectToolOutputSchema).length < 25_000);
	assert.ok(rendered(ProfiledListOutputSchema).length < 5_000);
});
