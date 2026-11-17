/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
export {};
declare global {
	interface ReaderHeading {
		level: number;
		text: string;
		anchor: string;
		start: number;
	}
	interface ReaderKey {
		key: string;
		metaKey?: boolean;
		altKey?: boolean;
		ctrlKey?: boolean;
		shiftKey?: boolean;
		isComposing?: boolean;
	}
	interface ReaderUICommand {
		name: string;
		args?: Record<string, unknown>;
	}
	type ReaderAskState = "draft" | "sending" | "sent" | "admitted" | "working" | "answered" | "failed" | "unknown";
	interface ReaderAskMessage {
		requestId: string;
		text: string;
		state: ReaderAskState;
		detail?: string;
	}
	interface ReaderThread {
		threadId: string;
		quote?: string;
		range?: ReaderRange;
		draft: string;
		messages: ReaderAskMessage[];
		collapsed: boolean;
	}
	interface ReaderUILogic {
		keyCommand(key: ReaderKey, context: { writing: boolean; input: boolean }): ReaderUICommand | null;
		findStatus(count: number, index: number): string;
		currentHeading(rows: { start: number; top: number }[], threshold: number): number;
		promptTransition(old: ReaderAskState, next: ReaderAskState): ReaderAskState;
		promptLabel(state: ReaderAskState): string;
		diffWords(oldText: string, newText: string): { kind: "same" | "removed" | "added"; text: string }[];
	}
	interface ReaderUIHelpers {
		element<K extends keyof HTMLElementTagNameMap>(
			tag: K,
			attrs?: Record<string, string>,
			...children: (Node | string | null | undefined)[]
		): HTMLElementTagNameMap[K];
		icon(name: string): SVGSVGElement;
		button(
			label: string,
			icon: string,
			action: () => void,
			options?: { iconOnly?: boolean; key?: string; className?: string },
		): HTMLButtonElement;
		get<T extends HTMLElement = HTMLElement>(selector: string): T;
		clear(el: Element): void;
	}
	interface ReaderUIContext {
		host: ReaderCoreHost;
		controller: ReaderController;
		editor: ReaderEditor;
		app: HTMLElement;
		page: HTMLElement;
		doc: HTMLElement;
		headings(): ReaderHeading[];
		command(name: string, args?: Record<string, unknown>): void;
		hostCommand(name: string, args?: Record<string, unknown>): Promise<unknown>;
		notice(text: string, tone?: string, actions?: { label: string; run: () => void }[], id?: string): void;
		toast(text: string, action?: { label: string; run: () => void }): void;
	}
	interface ReaderNavigation {
		rebuild(): void;
		updateCurrent(): void;
		toggleOutline(): void;
		closeSheet(): boolean;
		find(args?: Record<string, unknown>): void;
		closeFind(): boolean;
		findNext(delta: number): void;
		refreshFind(): void;
		replace(): void;
		jump(start: number): void;
		jumpElement(el: Element): void;
		back(forward?: boolean): void;
		dispose(): void;
	}
	interface ReaderAskUI {
		open(selection?: ReaderSelection | null): void;
		close(): boolean;
		refresh(): void;
		showChanges(id?: string): void;
		dispose(): void;
	}
	interface ReaderViewsUI {
		menu(): void;
		appearance(): void;
		open(): void;
		show(kind: string, args?: Record<string, unknown>): void;
		close(): boolean;
		imageZoom(mode: string): void;
		dispose(): void;
	}
	interface ReaderUI {
		command(name: string, args?: Record<string, unknown>): void;
		dispose(): void;
	}
	interface ReaderCoreAPI {
		createNativeHost(): ReaderCoreHost;
		setRenderedHTML(element: HTMLElement, html: string): void;
		uiLogic: ReaderUILogic;
		uiDOM: ReaderUIHelpers;
		createNavigation(context: ReaderUIContext): ReaderNavigation;
		createAskUI(context: ReaderUIContext, navigation: ReaderNavigation): ReaderAskUI;
		createViewsUI(context: ReaderUIContext, navigation: ReaderNavigation): ReaderViewsUI;
		createUI(host: ReaderCoreHost, controller: ReaderController, editor: ReaderEditor): ReaderUI;
		boot(host?: ReaderCoreHost): {
			host: ReaderCoreHost;
			controller: ReaderController;
			editor: ReaderEditor;
			ui: ReaderUI;
			dispose(): void;
		};
	}
}
