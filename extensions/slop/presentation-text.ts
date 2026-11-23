import { stripVTControlCharacters } from "node:util";

export const terminalText = (value: string) =>
	stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" || char === "\t" ? char : ""));
export const singleLine = (value: string) => terminalText(value).replace(/\s+/g, " ").trim();
