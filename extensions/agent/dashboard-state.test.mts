import assert from "node:assert/strict";
import { it } from "node:test";
import { createDashboardState, DashboardNavigation, agentState, dashboardSessionState } from "./dashboard-state.ts";
import { row } from "./dashboard-test-fixture.mts";
it("Esc pops each surface and never changes a draft or stops work", () => {
	const state = createDashboardState();
	state.selected = "one";
	const draft = agentState(state, "one");
	draft.draft = "/literal";
	draft.mode = "followUp";
	const nav = new DashboardNavigation(state);
	for (const screen of ["message", "console", "new", "find", "actions", "help", "tasks", "result"] as const) {
		nav.enter(screen);
		assert.equal(nav.escape(), "back");
		assert.equal(nav.screen, "roster");
	}
	state.filter = "audit";
	assert.equal(nav.escape(), "back");
	assert.equal(state.filter, "");
	assert.equal(nav.escape(), "close");
	assert.equal(draft.draft, "/literal");
	assert.equal(draft.mode, "followUp");
});
it("recipient stays fixed while roster metadata changes", () => {
	const state = createDashboardState();
	state.selected = "one";
	const nav = new DashboardNavigation(state);
	nav.enter("message");
	nav.reconcile([row("two")]);
	assert.equal(nav.target, "one");
	assert.equal(state.selected, "two");
});
it("selection and drafts stay local to the primary identity across reopen", () => {
	const state = dashboardSessionState("primary-a");
	state.selected = "one";
	agentState(state, "one").draft = "kept";
	assert.equal(dashboardSessionState("primary-a"), state);
	assert.notEqual(dashboardSessionState("primary-b"), state);
});
