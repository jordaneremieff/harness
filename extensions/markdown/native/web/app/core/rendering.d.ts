export {};
declare global {
	interface ReaderCoreAPI {
		/** Accepts only HTML from the host's cmark document, review or detached-text renderer. */
		setRenderedHTML(element: HTMLElement, html: string): void;
		/** Language tokens of code text; the token texts join to the exact input. */
		syntax: {
			supports(language: string): boolean;
			tokens(text: string, language: string): { text: string; kind?: string }[];
			/** A language for an unlabelled block whose text identifies it, or an empty string. */
			detect(text: string): string;
			/** The key of the scanner or grammar that colours a language label, or an empty string. */
			canonical(language: string): string;
			/** The syntaxes a person can choose for a code block: canonical keys with display names. */
			choices: readonly { readonly id: string; readonly label: string }[];
		};
		/** Colours the rendered code figures inside an element; absent where the highlighter is not loaded. */
		highlightCode?(element: HTMLElement): void;
		/**
		 * Colours one code figure by a syntax, by its own label or text when `language` is undefined, or
		 * not at all for an empty string. Returns the canonical key that colours it, or an empty string.
		 */
		colourCode?(figure: HTMLElement, language?: string): string;
	}
}
