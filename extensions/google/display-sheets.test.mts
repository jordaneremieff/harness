import assert from "node:assert/strict";
import { test } from "node:test";
import type { Data } from "./display-data.ts";
import { sheetsPresenters } from "./display-sheets.ts";

function result(name: string, data: Data, args: Data = {}) {
	const card = sheetsPresenters[name]?.result({ args, data, error: {}, status: "ok", isError: false });
	assert.ok(card);
	return card;
}

const firstTab = { sheetId: 0, index: 0, title: "Intake", rowCount: 1000, columnCount: "26" };

test("spreadsheet metadata and creation show the returned sheet and resource identity", () => {
	const data = { spreadsheetId: "grid-42", externalData: { title: "Inventory", sheets: [firstTab] } };
	const metadata = result("sheets_get", data);
	assert.match(metadata.outcome, /1 sheet tab/);
	assert.deepEqual(metadata.body, ["Inventory", "Intake · sheet 0 · tab 1 · 1000 rows · 26 columns"]);
	const created = result("sheets_create", { ...data, spreadsheetUrl: "https://example.test/grid-42" });
	assert.match(created.outcome, /^Created/);
	assert.deepEqual(created.details, ["Spreadsheet: grid-42", "https://example.test/grid-42"]);
	assert.doesNotMatch(result("sheets_create", {}).outcome, /^Created/);
	assert.match(result("sheets_sheet_add", { externalData: { sheet: firstTab } }).outcome, /^Added/);
	assert.doesNotMatch(result("sheets_sheet_add", { spreadsheetId: "grid-42" }).outcome, /^Added/);
});

test("values page preserves row boundaries, empty cells and the exact continuation", () => {
	const args = {
		spreadsheetId: "grid-42",
		range: "Intake!A4:C90",
		limit: 2,
		cursor: "0",
		valueRenderOption: "FORMULA",
	};
	const presenter = sheetsPresenters.sheets_values_get;
	assert.ok(presenter);
	assert.deepEqual(presenter.call(args).facts, ["grid-42", "limit 2"]);
	const page = result(
		"sheets_values_get",
		{
			range: "Intake!A4:C90",
			externalData: {
				values: [
					["=1+1", "", "north, west"],
					["0", "false", "first\nsecond"],
				],
				nextCursor: "2",
				truncatedCells: 1,
			},
		},
		args,
	);
	assert.match(page.outcome, /2 rows on the first page.*More rows/);
	assert.deepEqual(page.body, ['Row 1 · =1+1, "", "north, west"', 'Row 2 · 0, false, "first\nsecond"']);
	assert.match(page.details?.join(" ") ?? "", /truncated 1 cell/);
	assert.deepEqual(page.next, { args: { ...args, cursor: "2" } });
	const last = result("sheets_values_get", { externalData: { values: [] } }, page.next?.args);
	assert.match(last.outcome, /0 rows at range offset 2.*No next page/);
	assert.equal(last.next, undefined);
});

test("values writes hide submitted cells and describe the returned write receipt", () => {
	const args = { spreadsheetId: "grid-42", range: "Intake!A4:C90", values: [["private text", 0], [null]] };
	for (const name of ["sheets_values_update", "sheets_values_append"]) {
		const presenter = sheetsPresenters[name];
		assert.ok(presenter);
		assert.deepEqual(presenter.call(args), {
			subject: "Intake!A4:C90",
			facts: ["grid-42"],
			args: { values: "2 rows, 3 cells" },
		});
	}
	const updated = result(
		"sheets_values_update",
		{ updatedRange: "Intake!A4:B5", updatedRows: 2, updatedColumns: 2, updatedCells: 3 },
		args,
	);
	assert.match(updated.outcome, /Updated 3 cells/);
	assert.deepEqual(updated.body, ["Write range Intake!A4:B5", "2 rows", "2 columns"]);
	const emptyWrite = result("sheets_values_append", { updatedRows: 0, updatedColumns: 0, updatedCells: 0 });
	assert.deepEqual(emptyWrite.body, []);
	assert.match(emptyWrite.outcome, /0 cells/);
	assert.doesNotMatch(result("sheets_values_append", { spreadsheetId: "grid-42" }).outcome, /^Appended/);
	assert.equal(
		sheetsPresenters.sheets_values_append?.result({
			args,
			data: { updatedCells: 1 },
			error: {},
			isError: true,
			status: "error",
		}),
		undefined,
	);
});
