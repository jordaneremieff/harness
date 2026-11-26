type Data = Record<string, unknown>;
const pageBytes = 40_000;
const collections = ["docs", "views", "threads"] as const;
function offset(value: unknown): number {
	if (value === undefined) return 0;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw Error("Invalid result offset.");
	return value;
}

export function statePage(data: Data, input: Data): Data {
	const start = offset(input.offset);
	if (start > 0 && input.seq !== data.seq) throw Error("The workspace changed. Read state again from offset zero.");
	const limit = input.limit === undefined ? 80 : Math.min(256, Math.max(1, offset(input.limit)));
	const rows = collections.flatMap((key) => ((data[key] as unknown[]) ?? []).map((row) => ({ key, row })));
	if (start > rows.length) throw Error("Offset is past the end of this workspace state.");
	const groups: Record<(typeof collections)[number], unknown[]> = { docs: [], views: [], threads: [] };
	let n = start,
		bytes = 0;
	for (const { key, row } of rows.slice(start, start + limit)) {
		const size = Buffer.byteLength(JSON.stringify(row));
		if (n > start && bytes + size > pageBytes) break;
		groups[key].push(row);
		n++;
		bytes += size;
	}
	return { ...data, ...groups, offset: start, nextOffset: n < rows.length ? n : null, total: rows.length };
}

export function browsePage(data: Data, input: Data): Data {
	const key = input.op === "tree" ? "entries" : input.op === "git" ? "files" : "hits";
	const entries = data[key];
	if (!Array.isArray(entries)) return data;
	const result = { ...data };
	if (typeof result.diff === "string" && result.diff.length > 16000) {
		result.diff = result.diff.slice(0, 16000).replace(/[\ud800-\udbff]$/, "");
		result.limited = true;
	}
	let bytes = 0,
		n = 0;
	for (const row of entries) {
		const size = Buffer.byteLength(JSON.stringify(row));
		if (n > 0 && bytes + size > pageBytes) break;
		bytes += size;
		n++;
	}
	if (n < entries.length) {
		result[key] = entries.slice(0, n);
		if (key === "entries") result.next = offset(input.offset) + n;
		else result.limited = true;
	}
	return result;
}
