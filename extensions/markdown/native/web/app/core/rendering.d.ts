export {};
declare global {
	interface ReaderCoreAPI {
		/** Accepts only HTML from the host's cmark document or review renderer. */
		setRenderedHTML(element: HTMLElement, html: string): void;
		/** Language tokens of code text; the token texts join to the exact input. */
		syntax: {
			supports(language: string): boolean;
			tokens(text: string, language: string): { text: string; kind?: string }[];
			/** A language for an unlabelled block whose text identifies it, or an empty string. */
			detect(text: string): string;
		};
		/** Colours the rendered code figures inside an element; absent where the highlighter is not loaded. */
		highlightCode?(element: HTMLElement): void;
	}
}
