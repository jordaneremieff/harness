import { arr, bool, int, nul, num, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import { SCOPES } from "./gws.ts";
import { external, GoogleError, ok, TextBudget } from "./result.ts";
import type { ToolSpec } from "./tools.ts";

const SpreadsheetId = str({ minLength: 1, maxLength: 512 });
const Range = str({ minLength: 1, maxLength: 1024 });
const Cell = union([str({ maxLength: 65536 }), num(), bool(), nul()]);
const Values = arr(arr(Cell, { maxItems: 100 }), { minItems: 1, maxItems: 100 });
const readScopes = [SCOPES.sheetsRead, SCOPES.sheets, SCOPES.driveRead, SCOPES.driveFile, SCOPES.drive];
const writeScopes = [SCOPES.sheets, SCOPES.driveFile, SCOPES.drive];

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}
function boundedValues(value: unknown, offset: number, limit: number) {
	const all = Array.isArray(value) ? value : [];
	const rows = all.slice(offset, offset + limit);
	const budget = new TextBudget();
	let truncatedCells = 0;
	const values = rows.map((row) =>
		(Array.isArray(row) ? row : []).map((cell) => {
			const source = typeof cell === "string" ? cell : cell === undefined ? "" : JSON.stringify(cell);
			const clipped = budget.clip(source, 8192);
			if (clipped.truncated) truncatedCells++;
			return clipped.text;
		}),
	);
	return { values, nextCursor: offset + limit < all.length ? String(offset + limit) : undefined, truncatedCells };
}
function sheetView(sheet: Record<string, unknown>, budget: TextBudget) {
	const properties = object(sheet.properties) ? sheet.properties : {};
	const grid = object(properties.gridProperties) ? properties.gridProperties : {};
	return {
		sheetId: properties.sheetId,
		index: properties.index,
		title: budget.clip(properties.title, 2048).text,
		rowCount: grid.rowCount,
		columnCount: grid.columnCount,
	};
}
function spreadsheetView(response: Record<string, unknown>) {
	const budget = new TextBudget();
	return {
		spreadsheetId: text(response.spreadsheetId),
		externalData: external("sheets", {
			title: budget.clip(object(response.properties) ? response.properties.title : "", 2048).text,
			sheets: (Array.isArray(response.sheets) ? response.sheets.filter(object) : []).map((sheet) =>
				sheetView(sheet, budget),
			),
		}),
	};
}
function updateResult(response: Record<string, unknown>) {
	return {
		spreadsheetId: text(response.spreadsheetId),
		updatedRange: text(response.updatedRange),
		updatedRows: typeof response.updatedRows === "number" ? response.updatedRows : undefined,
		updatedColumns: typeof response.updatedColumns === "number" ? response.updatedColumns : undefined,
		updatedCells: typeof response.updatedCells === "number" ? response.updatedCells : undefined,
	};
}

export const sheetsTools: ToolSpec[] = [
	{
		name: "sheets_get",
		label: "Sheets metadata",
		description: "Read spreadsheet and sheet metadata without grid values.",
		parameters: obj({ spreadsheetId: SpreadsheetId }),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: readScopes }, signal, async (operation) => {
				const args = value as { spreadsheetId: string };
				const response = await operation.call<Record<string, unknown>>("sheets", ["spreadsheets", "get"], {
					params: { spreadsheetId: args.spreadsheetId, includeGridData: false },
				});
				return ok(spreadsheetView(response));
			}),
	},
	{
		name: "sheets_create",
		label: "Sheets create",
		description: "Create a new spreadsheet with a title.",
		parameters: obj({ title: str({ minLength: 1, maxLength: 1024 }) }),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: writeScopes }, signal, async (operation) => {
				const args = value as { title: string };
				const response = await operation.call<Record<string, unknown>>("sheets", ["spreadsheets", "create"], {
					body: { properties: { title: args.title } },
				});
				return ok({ ...spreadsheetView(response), spreadsheetUrl: text(response.spreadsheetUrl) || undefined });
			}),
	},
	{
		name: "sheets_sheet_add",
		label: "Sheets add sheet",
		description: "Add one sheet tab with a title to an existing spreadsheet.",
		parameters: obj({ spreadsheetId: SpreadsheetId, title: str({ minLength: 1, maxLength: 512 }) }),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: writeScopes }, signal, async (operation) => {
				const args = value as { spreadsheetId: string; title: string };
				const response = await operation.call<Record<string, unknown>>("sheets", ["spreadsheets", "batchUpdate"], {
					params: { spreadsheetId: args.spreadsheetId },
					body: { requests: [{ addSheet: { properties: { title: args.title } } }] },
				});
				const reply = Array.isArray(response.replies) ? response.replies.find(object) : undefined;
				return ok({
					spreadsheetId: text(response.spreadsheetId) || args.spreadsheetId,
					externalData: external("sheets", {
						sheet: sheetView(reply && object(reply.addSheet) ? reply.addSheet : {}, new TextBudget()),
					}),
				});
			}),
	},
	{
		name: "sheets_values_get",
		label: "Sheets values",
		description: "Read a bounded row slice of cell values as untrusted external data.",
		parameters: obj({
			spreadsheetId: SpreadsheetId,
			range: Range,
			limit: opt(int({ minimum: 1, maximum: 100, default: 50 })),
			cursor: opt(str({ pattern: "^\\d+$", maxLength: 20 })),
			valueRenderOption: opt(oneOf(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"])),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: readScopes }, signal, async (operation) => {
				const args = value as {
					spreadsheetId: string;
					range: string;
					limit?: number;
					cursor?: string;
					valueRenderOption?: string;
				};
				const cursor = Number.parseInt(args.cursor ?? "0", 10);
				if (String(cursor) !== (args.cursor ?? "0") || cursor < 0)
					throw new GoogleError("INVALID_ARGUMENT", "Invalid Sheets row cursor.");
				const response = await operation.call<Record<string, unknown>>("sheets", ["spreadsheets", "values", "get"], {
					params: {
						spreadsheetId: args.spreadsheetId,
						range: args.range,
						majorDimension: "ROWS",
						valueRenderOption: args.valueRenderOption ?? "FORMATTED_VALUE",
					},
				});
				const page = boundedValues(response.values, cursor, args.limit ?? 50);
				return ok({
					spreadsheetId: text(response.spreadsheetId) || args.spreadsheetId,
					range: text(response.range) || args.range,
					externalData: external("sheets", page),
				});
			}),
	},
	...(
		[
			{
				action: "update",
				name: "sheets_values_update",
				description: "Replace cell values in one explicit Sheets range.",
			},
			{ action: "append", name: "sheets_values_append", description: "Append rows after one explicit Sheets range." },
		] as const
	).map(
		(item): ToolSpec => ({
			name: item.name,
			label: item.action === "update" ? "Sheets update" : "Sheets append",
			description: item.description,
			parameters: obj({
				spreadsheetId: SpreadsheetId,
				range: Range,
				values: Values,
				valueInputOption: opt(oneOf(["RAW", "USER_ENTERED"])),
				...(item.action === "append" ? { insertDataOption: opt(oneOf(["INSERT_ROWS", "OVERWRITE"])) } : {}),
			}),
			replay: "unsafe",
			execute: async (value, runtime, signal) =>
				runtime.run({ scopes: writeScopes }, signal, async (operation) => {
					const args = value as {
						spreadsheetId: string;
						range: string;
						values: unknown[][];
						valueInputOption?: string;
						insertDataOption?: string;
					};
					const response = await operation.call<Record<string, unknown>>(
						"sheets",
						["spreadsheets", "values", item.action],
						{
							params: {
								spreadsheetId: args.spreadsheetId,
								range: args.range,
								valueInputOption: args.valueInputOption ?? "USER_ENTERED",
								...(item.action === "append" ? { insertDataOption: args.insertDataOption ?? "INSERT_ROWS" } : {}),
							},
							body: { majorDimension: "ROWS", values: args.values },
						},
					);
					return ok(
						item.action === "append" && object(response.updates)
							? updateResult(response.updates)
							: updateResult(response),
					);
				}),
		}),
	),
];
