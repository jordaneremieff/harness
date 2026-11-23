/** Keep at most this many UTF-16 units without splitting a Unicode code point. */
export function textPrefix(text: string, units: number): string {
	if (text.length <= units) return text;
	const splitPair = (text.codePointAt(units - 1) ?? 0) > 0xffff;
	return text.slice(0, splitPair ? units - 1 : units);
}
