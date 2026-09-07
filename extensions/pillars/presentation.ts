import type { Response } from "./readback.ts";

export function usageMarkdown(response: Response): string {
	if (response.kind === "error")
		return `# Pillars access evidence\n\n${response.message}\n\n${Object.values(response.meaning).join("\n\n")}`;
	const lines = [
		"# Pillars access evidence",
		`${response.window.fromDay} through ${response.window.toDay}. Page ${response.pagination.pageNumber} of ${response.pagination.pageCount}.`,
		`Retained shards: ${response.coverage.retainedDayShards}. Collector enabled here: ${response.enabled}.`,
		`Storage assessment: ${response.storageEvidence.assessment}. Live collectors, whole-window coverage, and unpersisted loss: unknown.`,
		"## Totals",
		...Object.entries(response.totals).map(([name, count]) => `- ${name}: ${count}`),
		"## Recorded storage evidence",
		...Object.entries(response.storageEvidence).map(([name, value]) => `- ${name}: ${value}`),
		`Capture omissions: ${response.coverage.captureOmissions.join(", ") || "none recorded; not complete collection"}.`,
		`Revision rows: ${response.summary.revisionRows}. Additional resource identities folded in this overview: ${response.summary.foldedResourceIdentities}.`,
		"## Rows",
	];
	const rows = response.view === "revisions" ? response.rows : response.byResource;
	for (const row of rows) {
		lines.push(`### ${row.resourceClass}: ${row.resourceId}`);
		if ("observationStage" in row)
			lines.push(
				`Day: ${row.day}; stage: ${row.observationStage}.`,
				`Model: ${row.model}; reasoning: ${row.reasoning}.`,
				`Reference SHA-256: ${row.referenceBodyDigest}.`,
				`Observer version: ${row.observerVersion}; Pi version: ${row.piVersion}.`,
			);
		else lines.push(`Last observed day: ${row.lastSeenDay}.`);
		lines.push(
			Object.entries(row.counters)
				.map(([name, count]) => `${name}: ${count}`)
				.join("; "),
		);
	}
	lines.push("## Interpretation", ...Object.values(response.meaning));
	if (response.pagination.nextCursor)
		lines.push(
			`Next page: /pillars next ${response.pagination.nextCursor}`,
			`Capture expires at ${response.pagination.cursorExpiresAt}.`,
		);
	return lines.join("\n\n");
}
