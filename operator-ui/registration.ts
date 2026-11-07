/**
 * The registration entry of the shared operator presentation: announcing destinations, opening
 * the frame, and the loading view an owner returns before its content is read.
 *
 * Extension factories use this entry so that evaluating an entrypoint does not evaluate the
 * frame, form, list, browser or reader implementations. A published view returns a
 * `LoadingView` at once; the owner imports its view module inside the load callback, and the
 * loaded view replaces the placeholder in place. Loading this entry evaluates no frame.
 * See docs/conventions/operator-panels.md.
 */
export { LoadingView } from "./loading.ts";
export {
	type FrameApi,
	type OpenFrameOptions,
	OPERATOR_FRAME_OPEN,
	OPERATOR_VIEW_PUBLISH,
	OPERATOR_VIEW_REQUEST,
	openOperatorFrame,
	type OperatorViewPublication,
	type OrdinaryView,
	publishOperatorViews,
	type PublishedView,
} from "./ordinary.ts";
export type { Action, JsonValue, KeyHint, Notice, NoticeKind, OperatorView, ViewHost, ViewTarget } from "./view.ts";
