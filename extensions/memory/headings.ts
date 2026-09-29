interface Heading {
	start: number;
	end: number;
	text: string;
	title: string;
}

/** Locate an ATX heading without treating fenced examples as headings. */
export function findMarkdownHeading(body: string, maxLevel = 6): Heading | undefined {
	let fence: { marker: string; length: number } | undefined;
	for (const match of body.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
		const line = match[0].replace(/[\r\n]+$/, "");
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && /^[ \t]*$/.test(marker[2]))
				fence = undefined;
			continue;
		}
		if (marker && (marker[1][0] === "~" || !marker[2].includes("`"))) {
			fence = { marker: marker[1][0], length: marker[1].length };
			continue;
		}
		const heading = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(line);
		if (heading && heading[1].length <= maxLevel)
			return {
				start: match.index,
				end: match.index + match[0].length,
				text: match[0],
				title: heading[2].replace(/[ \t]+#+[ \t]*$/, "").trim(),
			};
	}
	return undefined;
}
