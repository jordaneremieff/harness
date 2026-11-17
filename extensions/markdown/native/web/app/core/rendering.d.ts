export {};
declare global {
	interface ReaderCoreAPI {
		/** Accepts only HTML from the host's cmark document or review renderer. */
		setRenderedHTML(element: HTMLElement, html: string): void;
	}
}
