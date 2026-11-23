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
	type ReaderAskState =
		| "draft"
		| "sending"
		| "sent"
		| "admitted"
		| "working"
		| "answered"
		| "unanswered"
		| "failed"
		| "unknown";
	interface ReaderPromptVersion {
		documentKey: string;
		presentation: string;
		generation: number;
	}
	interface ReaderAskDocument {
		documentKey: string;
		digest?: string;
		threads: ReaderThread[];
		comments: ReaderComment[];
		overall: string;
		overallRevision?: number;
		current: ReaderThread | null;
		visible: boolean;
		heldThread: ReaderThread | null;
	}
	interface ReaderAskDelivery {
		owner: ReaderAskDocument;
		thread: ReaderThread;
		message: ReaderAskMessage;
	}
	interface ReaderAskSessions {
		readonly shown: ReaderAskDocument;
		show(key: string, source: string, digest?: string): ReaderAskDocument;
		change(edits: ReaderEdit[], source: string): void;
		register(owner: ReaderAskDocument, thread: ReaderThread, message: ReaderAskMessage): void;
		delivery(requestId: string, threadId: string): ReaderAskDelivery | undefined;
		packet(thread: ReaderThread, message: ReaderAskMessage, version: ReaderPromptVersion): Record<string, unknown>;
		releasePacket(message: ReaderAskMessage): void;
		forget(message: ReaderAskMessage): void;
	}
	interface ReaderAskMessage {
		authoredRevision?: number;
		requestId: string;
		text: string;
		state: ReaderAskState;
		detail?: string;
		retryable?: boolean;
	}
	interface ReaderPassageView {
		/** All native blocks for this exact source. An unavailable paragraph map cannot establish uniqueness. */
		blocks: readonly ReaderMappedBlock[];
		map?(block: ReaderMappedBlock): ReturnType<ReaderSourceModelAPI["map"]> | undefined;
	}
	interface ReaderPassageAnchor {
		/** Exact native heading source from outermost to innermost; absent without a unique section. */
		headings?: string[];
		rendered?: { before: string; text: string; after: string };
		text: string;
		/** Each context identified only this occurrence when the passage was selected. */
		contexts: { before: string; after: string }[];
	}
	interface ReaderComment {
		authoredRevision?: number;
		text: string;
		quote?: string;
		sourceAnchor?: ReaderPassageAnchor;
		range?: ReaderRange;
	}
	interface ReaderThread {
		authoredRevision?: number;
		draftRevision?: number;
		threadId: string;
		quote?: string;
		sourceAnchor?: ReaderPassageAnchor;
		range?: ReaderRange;
		pendingComment?: ReaderComment;
		comments?: ReaderComment[];
		/** The overall comment that a sent batch carried with its comments. */
		overall?: string;
		draft: string;
		messages: ReaderAskMessage[];
	}
	interface ReaderDiffPart {
		kind: "same" | "removed" | "added";
		text: string;
	}
	interface ReaderMenuTarget {
		area: "document" | "input" | "other";
		lock: "reading" | "writing";
		selection: boolean;
		selectionInOneBlock: boolean;
		editor: boolean;
		block: boolean;
		heading: boolean;
		link?: { internal: boolean };
		/** A pending comment or an asked question marks the clicked text. */
		annotation?: "comment" | "question";
		image: boolean;
		imageAlt: boolean;
		code: boolean;
		table: boolean;
		inputSelection: boolean;
		inputEditable: boolean;
	}
	interface ReaderMenuEntry {
		id: string;
		label: string;
		key: string;
		enabled: boolean;
		separator?: boolean;
	}
	interface ReaderMenuContext {
		point: { x: number; y: number };
		target: ReaderMenuTarget;
		input: HTMLInputElement | HTMLTextAreaElement | null;
		selection: ReaderSelection | null;
		block: HTMLElement | null;
		link: HTMLAnchorElement | null;
		image: HTMLElement | null;
	}
	interface ReaderContextMenu {
		isOpen(): boolean;
		close(): boolean;
		dispose(): void;
	}
	interface ReaderUILogic {
		contextMenuItems(target: ReaderMenuTarget): ReaderMenuEntry[];
		menuPlacement(
			point: { x: number; y: number },
			size: { width: number; height: number },
			pane: { width: number; height: number },
		): { left: number; top: number; maxHeight: number };
		stripPlacement(
			selection: { top: number; bottom: number; left: number; right: number },
			strip: { width: number; height: number },
			pane: { width: number; height: number; top: number },
		): { left: number; top: number; side: "above" | "below" };
		cardPlacement(
			anchor: { top: number; bottom: number; left: number },
			card: { width: number; height: number },
			pane: { width: number; height: number; top: number },
		): { left: number; top: number; maxHeight: number; side: "below" | "above" | "over" };
		zoomStep(current: number, steps: readonly number[], direction: number | null): number;
		keyCommand(key: ReaderKey, context: { writing: boolean; input: boolean }): ReaderUICommand | null;
		findStatus(count: number, index: number): string;
		currentHeading(rows: { start: number; top: number }[], threshold: number): number;
		promptTransition(old: ReaderAskState, next: ReaderAskState): ReaderAskState;
		promptLabel(state: ReaderAskState): string;
		capturePassage(
			source: string,
			range?: ReaderRange,
			view?: ReaderPassageView,
			quote?: string,
		): ReaderPassageAnchor | undefined;
		reanchorPassage(
			source: string,
			anchor?: ReaderPassageAnchor,
			view?: ReaderPassageView,
			within?: ReaderRange,
		): ReaderRange | undefined;
		diffWords(oldText: string, newText: string): ReaderDiffPart[] | null;
		changeContext(
			source: string,
			span: ReaderRange,
			edit: ReaderRange & { oldText: string; newText: string },
		): { prefix: string; suffix: string } | null;
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
		onMenuOpen?(): void;
		clearSelection?(): void;
		/** Shows the document text that holds a node before a find match there comes into view. */
		reveal?(node: Node): void;
		/** The kind of mark at a point of the page, if a comment or a question marks the text there. */
		annotationAt?(x: number, y: number): "comment" | "question" | null;
	}
	interface ReaderCodeViews {
		/** Adds the controls of new code blocks and applies each block's chosen view. */
		decorate(): void;
		reveal(node: Node): void;
		/** Opens the block of a rendered code view at its code; false when no rendered view holds the element. */
		edit(target: Element, options: { oneOff?: boolean }): boolean;
		/** Copies the code of the block at an element; false when no fenced block holds it. */
		copy(target: Element): boolean;
		dispose(): void;
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
		noteHeld(): void;
		letAgentChange(): void;
		/** The kind of mark at a point of the page: a pending comment or a question already asked. */
		annotationAt(x: number, y: number): "comment" | "question" | null;
		/** Opens the card of the mark at a point; false when no mark is there. */
		openAt(x: number, y: number): boolean;
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
		textZoom(delta: number | null): void;
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
		createAskSessions(): ReaderAskSessions;
		createViewsUI(context: ReaderUIContext, navigation: ReaderNavigation): ReaderViewsUI;
		createContextMenu(
			context: ReaderUIContext,
			run: (id: string, context: ReaderMenuContext) => void | Promise<void>,
		): ReaderContextMenu;
		createCodeViews(context: ReaderUIContext, options?: { onChange?(): void }): ReaderCodeViews;
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
