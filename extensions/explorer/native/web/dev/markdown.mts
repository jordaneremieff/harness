// The browser fixture has no Swift runtime. This renderer exercises the preview bridge and line mapping.
const html = (text: string) =>
	text.replace(
		/[&<>"']/gu,
		(char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
	);

function inline(text: string) {
	let output = "",
		offset = 0;
	for (const match of text.matchAll(/`([^`]+)`|\[([^\]]+)\]\(([^\s)]+)\)|\*\*([^*]+)\*\*/gu)) {
		output += html(text.slice(offset, match.index));
		const [, code, label, href, bold] = match;
		if (code) output += `<code>${html(code)}</code>`;
		else if (bold) output += `<strong>${html(bold)}</strong>`;
		else output += `<a href="${html(href)}">${html(label)}</a>`;
		offset = match.index + match[0].length;
	}
	return output + html(text.slice(offset));
}

const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u;
const fence = /^(`{3,}|~{3,})\s*(\S*)/u;
const item = /^[-*+]\s+(.+)$/u;
const span = (lines: string[], start: number, end = start) =>
	` data-sourcepos="${start + 1}:1-${end + 1}:${lines[end].length}"`;

function codeBlock(lines: string[], start: number, fence: string, language: string) {
	let end = start + 1;
	while (end < lines.length && !lines[end].trim().startsWith(fence)) end++;
	const text = html(lines.slice(start + 1, end).join("\n"));
	end = Math.min(end, lines.length - 1);
	return { end, body: `<pre${span(lines, start, end)}><code class="language-${html(language)}">${text}</code></pre>` };
}

function listBlock(lines: string[], start: number) {
	const items: string[] = [];
	let cursor = start;
	for (; cursor < lines.length; cursor++) {
		const bullet = item.exec(lines[cursor]);
		if (!bullet) break;
		items.push(`<li${span(lines, cursor)}>${inline(bullet[1])}</li>`);
	}
	return { end: cursor - 1, body: `<ul${span(lines, start, cursor - 1)}>${items.join("\n")}</ul>` };
}

function block(lines: string[], start: number) {
	const row = lines[start];
	const h = heading.exec(row);
	if (h) {
		const tag = `h${h[1].length}`;
		return { end: start, body: `<${tag}${span(lines, start)}>${inline(h[2])}</${tag}>` };
	}
	const f = fence.exec(row);
	if (f) return codeBlock(lines, start, f[1], f[2]);
	if (item.test(row)) return listBlock(lines, start);
	let cursor = start + 1;
	while (lines[cursor]?.trim() && ![heading, fence, item].some((pattern) => pattern.test(lines[cursor]))) cursor++;
	return {
		end: cursor - 1,
		body: `<p${span(lines, start, cursor - 1)}>${inline(lines.slice(start, cursor).join("\n"))}</p>`,
	};
}

export function renderFixtureMarkdown(text: string) {
	const lines = text.split(/\r\n|\n|\r/u);
	const output: string[] = [];
	for (let cursor = 0; cursor < lines.length; cursor++) {
		if (!lines[cursor].trim()) continue;
		const { end, body } = block(lines, cursor);
		output.push(body);
		cursor = end;
	}
	return output.join("\n");
}
