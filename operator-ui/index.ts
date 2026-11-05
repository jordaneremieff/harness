/**
 * Shared operator presentation for harness extensions: one interaction model for browsing,
 * forms and navigation in ordinary Pi and in the attached Agent terminal. It owns no operation,
 * store, approval, model catalogue or trust decision; owners bind their own effects to it.
 * See docs/conventions/operator-panels.md.
 *
 * One effective binding per key: outside a text field, the keys of the focused view's current
 * hints are that view's binding and never reach an owner action; a hint key shown by an action
 * moves that action into More without the key. While a text field has focus every printable key
 * is text, so More opens on its chord (`MORE_CHORD`, ctrl+n) instead of its plain key.
 */
export { Browser, type BrowserOptions, type Scope, SPLIT_MIN_WIDTH } from "./browser.ts";
export { actionControl, actionLabel, type Control, Footer, MORE_CHORD, MORE_KEY, menuControl, renderTabs, type Tab } from "./controls.ts";
export { TextArea, TextField } from "./field.ts";
export { type Choice, type FieldSpec, Form, type FormOptions, type FormResult } from "./form.ts";
export { type Destination, type FrameOptions, NavigationFrame } from "./frame.ts";
export { type ClickResult, type HitRegion, HitMap } from "./hits.ts";
export { keyInput, keyMatches, keysText, keyText } from "./keys.ts";
export { ListView, type ListOptions } from "./list.ts";
export { LoadingView } from "./loading.ts";
export {
	collectOperatorViews,
	commandIdentity,
	commandLine,
	dispatchCommand,
	type DispatchOutcome,
	type FrameApi,
	frameRows,
	OPERATOR_FRAME_OPEN,
	OPERATOR_VIEW_PUBLISH,
	OPERATOR_VIEW_REQUEST,
	type OpenFrameOptions,
	type OperatorViewPublication,
	type OrdinaryView,
	openOperatorFrame,
	ordinaryTarget,
	type OwnerResolution,
	type PublishedView,
	publishOperatorViews,
	readPublication,
	resolveOwner,
	viewKey,
} from "./ordinary.ts";
export { type OperatorPanelModule, type PanelHost, readPanelModule } from "./panel.ts";
export { Reader, type ReaderContent, ReaderView } from "./reader.ts";
export { age, clip, fitLine, plainLine, plainText, spread, visibleWidth, wrap } from "./text.ts";
export type { Action, JsonValue, KeyHint, Notice, NoticeKind, OperatorView, ViewHost, ViewTarget } from "./view.ts";
