import { count, type Data, field, list, object, pick, type Presenter, text } from "./display-data.ts";

function rangeCall(args: Data) {
	const id = field(args.spreadsheetId);
	const range = field(args.range);
	return { subject: range || id, facts: id && range ? [id] : [] };
}

function integer(value: unknown): number | undefined {
	const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
	return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function sheetLine(value: unknown): string {
	const sheet = object(value);
	const title = field(sheet.title);
	const id = integer(sheet.sheetId);
	const index = integer(sheet.index);
	const rows = integer(sheet.rowCount);
	const columns = integer(sheet.columnCount);
	return [
		title,
		id === undefined ? "" : `sheet ${id}`,
		index === undefined ? "" : `tab ${index + 1}`,
		rows ? count(rows, "row") : "",
		columns ? count(columns, "column") : "",
	]
		.filter(Boolean)
		.join(" · ");
}

function spreadsheet(create: boolean): Presenter {
	return {
		call: (args) => ({ subject: field(create ? args.title : args.spreadsheetId) }),
		result({ data, status, isError }) {
			if (isError || status === "error") return;
			const contents = object(data.externalData);
			const id = field(data.spreadsheetId);
			const title = field(contents.title);
			const url = create ? field(data.spreadsheetUrl) : "";
			const tabs = list(contents.sheets).map(sheetLine).filter(Boolean);
			let outcome = "No sheet list was returned.";
			if (create) outcome = id ? "Created a spreadsheet." : "No spreadsheet creation receipt was returned.";
			else if (Array.isArray(contents.sheets)) {
				outcome = `Returned spreadsheet metadata with ${count(contents.sheets.length, "sheet tab")}.`;
			}
			return {
				outcome,
				body: [title, ...tabs].filter(Boolean),
				details: [id ? `Spreadsheet: ${id}` : "", url].filter(Boolean),
			};
		},
	};
}

function cellText(value: unknown): string {
	const safe = typeof value === "number" || typeof value === "boolean" || value === null ? String(value) : text(value);
	return /[,"\n]|^\s|\s$|^$/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function writeQuantities(data: Data) {
	const rows = integer(data.updatedRows);
	const columns = integer(data.updatedColumns);
	const cells = integer(data.updatedCells);
	const quantities = [
		cells !== undefined && rows ? count(rows, "row") : "",
		columns ? count(columns, "column") : "",
	].filter(Boolean);
	const quantity = cells !== undefined ? count(cells, "cell") : rows !== undefined ? count(rows, "row") : "";
	return { quantity, quantities };
}

function writeValues(action: "Updated" | "Appended"): Presenter {
	return {
		call(args) {
			const rows = list(args.values);
			const cells = rows.reduce<number>((total, row) => total + list(row).length, 0);
			const options = pick(args, "valueInputOption", ...(action === "Appended" ? ["insertDataOption"] : []));
			if (Array.isArray(args.values)) options.values = `${count(rows.length, "row")}, ${count(cells, "cell")}`;
			return { ...rangeCall(args), ...(Object.keys(options).length ? { args: options } : {}) };
		},
		result({ args, data, status, isError }) {
			if (isError || status === "error") return;
			const { quantity, quantities } = writeQuantities(data);
			const target = field(data.updatedRange);
			const id = field(data.spreadsheetId);
			return {
				outcome: quantity ? `${action} ${quantity}.` : "No cell or row count was returned for the write.",
				body: [target ? `Write range ${target}` : "", ...quantities].filter(Boolean),
				details: id && id !== field(args.spreadsheetId) ? [`Spreadsheet: ${id}`] : [],
			};
		},
	};
}

export const sheetsPresenters: Record<string, Presenter> = {
	sheets_get: spreadsheet(false),
	sheets_create: spreadsheet(true),
	sheets_sheet_add: {
		call: (args) => ({ subject: field(args.title), facts: [field(args.spreadsheetId)].filter(Boolean) }),
		result({ data, status, isError }) {
			if (isError || status === "error") return;
			const sheet = object(object(data.externalData).sheet);
			const line = sheetLine(sheet);
			return {
				outcome: integer(sheet.sheetId) === undefined ? "No new sheet tab was identified." : "Added a sheet tab.",
				body: line ? [line] : [],
			};
		},
	},
	sheets_values_get: {
		call(args) {
			const range = rangeCall(args);
			const offset = integer(args.cursor);
			const limit = integer(args.limit);
			const options = pick(args, "valueRenderOption");
			return {
				...range,
				facts: [...range.facts, offset ? `offset ${offset}` : "", limit === undefined ? "" : `limit ${limit}`].filter(
					Boolean,
				),
				...(Object.keys(options).length ? { args: options } : {}),
			};
		},
		result({ args, data, status, isError }) {
			if (isError || status === "error") return;
			const page = object(data.externalData);
			if (!Array.isArray(page.values)) return { outcome: "No row page was returned." };
			const rows = page.values;
			const cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
			const next = cursor
				? { args: { ...pick(args, "spreadsheetId", "range", "limit", "valueRenderOption"), cursor } }
				: undefined;
			const offset = integer(args.cursor) ?? 0;
			const range = field(data.range);
			const clipped = integer(page.truncatedCells);
			const body = rows.map((value, i) => {
				const cells = list(value).map(cellText).join(", ");
				return cells ? `Row ${offset + i + 1} · ${cells}` : `Row ${offset + i + 1}`;
			});
			const scope = offset ? `at range offset ${offset}` : "on the first page";
			return {
				outcome: `Returned ${count(rows.length, "row")} ${scope}. ${next ? "More rows are available." : "No next page was returned."}`,
				body,
				details: [
					range && range !== field(args.range) ? `Returned range: ${range}` : "",
					clipped ? `Sheets truncated ${count(clipped, "cell")} before display.` : "",
				].filter(Boolean),
				...(next ? { next } : {}),
			};
		},
	},
	sheets_values_update: writeValues("Updated"),
	sheets_values_append: writeValues("Appended"),
};
