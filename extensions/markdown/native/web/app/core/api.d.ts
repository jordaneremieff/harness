export {};
declare global {
	interface ReaderRange {
		start: number;
		end: number;
	}
	interface ReaderEdit extends ReaderRange {
		text: string;
		expected: string;
	}
	interface ReaderMappedBlock extends ReaderRange {
		key: string;
		type: string;
		html?: string;
		map?: [number, number, number, number][];
	}
	interface ReaderCoreHost {
		readonly capabilities: { menuBar: boolean; filePanels: boolean; returnFocus: boolean; windowChrome: string };
		on(type: string, handler: (message: unknown) => unknown): () => void;
		send(type: string, fields?: Record<string, unknown>): void;
		request(type: string, fields?: Record<string, unknown>): Promise<unknown>;
		dispose(): void;
	}
	interface ReaderCoreDocument {
		source: string;
		generation: number;
		presentation: string;
		meta: { documentKey: string; capturedSource: boolean; [key: string]: unknown };
		blocks: ReaderMappedBlock[];
		settings: { lock: "reading" | "writing"; [key: string]: unknown };
		[key: string]: unknown;
	}
	interface ReaderCoreChange {
		threadId?: string;
		origin: "person" | "agent" | "history";
		id: string;
		operationId?: string;
		historyAction?: string | null;
		baseGeneration: number;
		generation: number;
		edits: ReaderEdit[];
	}
	interface ReaderHistoryRecord {
		id: string;
		origin: "person" | "agent";
		blockId: string | null;
		group: string;
		at: number;
		edits: ReaderEdit[];
		inverse: ReaderEdit[];
	}
	interface ReaderRedoRecord {
		operationId?: string;
		origin: "person" | "agent";
		blockId: string | null;
		steps: ReaderEdit[][];
		conflict?: string;
	}
	interface ReaderOperationResult {
		status: string;
		reason?: string;
		id?: string;
		range?: ReaderRange;
		origin?: string;
		operations?: string[];
		events?: { source: string; edits: ReaderEdit[]; inverse: ReaderEdit[] }[];
	}
	interface ReaderApplyOptions {
		threadId?: string;
		now?: number;
		blockId?: string | null;
		id?: string;
		groupMs?: number;
		baseGeneration?: number;
	}
	interface ReaderExactDocument {
		source: string;
		generation: number;
		active: ({ blockId: string } & ReaderRange) | null;
		composing: boolean;
		caretPresent: boolean;
		records: ReaderHistoryRecord[];
		redos: ReaderRedoRecord[];
		listeners: Set<(change: ReaderCoreChange) => void>;
		setActive(key: string | null, range: ReaderRange | null): void;
		heldRange(now?: number): ReaderRange | null;
		apply(edits: ReaderEdit[], origin: "person" | "agent", options?: ReaderApplyOptions): ReaderOperationResult;
		undo(block?: string | null): ReaderOperationResult | null;
		redo(block?: string | null): ReaderOperationResult | null;
		undoAgent(id: string): ReaderOperationResult;
		seal(): void;
	}
	interface ReaderLineMap {
		source: string;
		display: string;
		toSource(position: number): number;
		toSourceEdit(edit: { start: number; end: number; text: string }): ReaderEdit;
	}
	interface ReaderTextPoint {
		node: Node;
		offset: number;
	}
	interface ReaderCoreAPI {
		exact: {
			Doc: new (source: string, generation?: number) => ReaderExactDocument;
			LineMap: new (source: string, ending?: string) => ReaderLineMap;
			dominantEnding(source: string): string;
			diff(a: string, b: string): { start: number; end: number; text: string };
			overlaps(a: ReaderRange, b: ReaderRange): boolean;
			applyEdits(source: string, edits: ReaderEdit[]): { source: string; edits: ReaderEdit[]; inverse: ReaderEdit[] };
			mapEdits(edits: ReaderEdit[], through: ReaderEdit[]): ReaderEdit[];
			DesyncError: new (edit: ReaderEdit, found: string) => Error;
		};
		sourceModel: ReaderSourceModelAPI;
		find: { literal(query: string): (text: string) => ReaderRange[] };
		createController(
			host: ReaderCoreHost,
			options?: { document?: ReaderCoreDocument; now?: () => number },
		): ReaderController;
		createEditor(
			controller: ReaderController,
			root: HTMLElement,
			options?: { scroll?: HTMLElement; plainSource?: boolean },
		): ReaderEditor;
	}
	interface ReaderSourceModelAPI {
		textNodes(root: Node): Text[];
		offset(root: Node, node: Node, offset: number): number | null;
		point(root: Node, offset: number): ReaderTextPoint;
		map(
			block: ReaderMappedBlock,
			source: string,
			element: HTMLElement,
		): { text: string; boundaries: (number | null)[] };
		sourceToDisplay(map: ReaderLineMap, position: number): number;
		tokens(text: string, type?: string): { text: string; kind: string }[];
	}
	interface ReaderClaim {
		claimId: string;
		ranges: ReaderRange[];
		label?: string;
		expiresAt: number;
	}
	interface ReaderHistoryDescription {
		origin: "person" | "agent";
		blockStart: number;
		operationId?: string;
	}
	interface ReaderAgentOperation {
		threadId?: string;
		operationId: string;
		unread: boolean;
		edits: { oldText: string; newText: string; start: number; end: number }[];
		conflicted: boolean;
	}
	interface ReaderSelection extends ReaderRange {
		text: string;
		anchor: number;
		focus: number;
	}
	interface ReaderNotice {
		tone: string;
		text: string;
		actions?: { id: string; label: string }[];
	}
	interface ReaderPageCommand {
		name: string;
		args?: Record<string, unknown>;
	}
	interface ReaderControllerEvents {
		document: ReaderCoreDocument;
		blocks: ReaderMappedBlock[];
		lock: "reading" | "writing";
		claims: ReaderClaim[];
		state: Record<string, unknown>;
		hold: ReaderRange | null;
		active: ({ blockId: string } & ReaderRange) | null;
		beforeChange: ReaderCoreChange;
		change: ReaderCoreChange;
		agentChange: ReaderCoreChange;
		beforeBlocks: ReaderMappedBlock[];
		notice: ReaderNotice;
		error: unknown;
		ack: Record<string, unknown>;
		refused: unknown;
		command: ReaderPageCommand;
		settings: Record<string, unknown>;
		selection: ReaderSelection | null;
		link: { href: string | null; element: Element };
		view: null;
		history: { undo: ReaderHistoryDescription | null; redo: ReaderHistoryDescription | null };
		agentOperations: ReaderAgentOperation[];
	}
	interface ReaderController {
		host: ReaderCoreHost;
		doc: ReaderExactDocument | null;
		payload: ReaderCoreDocument | null;
		blocks: ReaderMappedBlock[];
		lock: "reading" | "writing";
		claims: Map<string, ReaderClaim>;
		agentOperations: Map<string, ReaderAgentOperation>;
		markRead(id: string): void;
		nextHistory(): { undo: ReaderHistoryDescription | null; redo: ReaderHistoryDescription | null };
		on<K extends keyof ReaderControllerEvents>(
			type: K,
			handler: (detail: ReaderControllerEvents[K]) => void,
		): () => void;
		emit<K extends keyof ReaderControllerEvents>(type: K, detail: ReaderControllerEvents[K]): void;
		replace(payload: ReaderCoreDocument): void;
		setLock(lock: "reading" | "writing"): void;
		change(edits: ReaderEdit[], options?: { blockId?: string; now?: number }): ReaderOperationResult;
		undo(): ReaderOperationResult | null | undefined;
		redo(): ReaderOperationResult | null | undefined;
		undoAgent(id: string): ReaderOperationResult | undefined;
		activate(key: string | null): void;
		state(patch?: Record<string, unknown>): void;
		pickImage(range: ReaderRange): Promise<boolean>;
		requestRender(): void;
		dispose(): void;
	}
	interface ReaderEditor {
		open(
			key: string,
			point?: { x: number; y: number } | number,
			options?: { oneOff?: boolean; selection?: ReaderRange },
		): boolean;
		close(): boolean;
		releaseHold(): boolean;
		dispose(): void;
		selection(): ReaderSelection | null;
		replaceSelection(text: string): boolean;
		/** Inserts plain text at the caret or over the selection, as the paste key does. */
		paste(text: string): boolean;
		/** Removes the selection as the cut key does and returns its text, or null. */
		cut(): string | null;
		hasCaret(): boolean;
		format(command: string | { command: string; level?: number }): boolean;
		toggleTask(key: string, offset?: number): boolean;
		index(): {
			key: string;
			text: string;
			start: number;
			end: number;
			ranges: (start: number, end: number) => Range[];
		}[];
		find(query: string): { key: string; start: number; end: number; ranges: Range[] }[];
		highlight(name: string, ranges: Range[]): void;
		restyles: number;
	}
}
