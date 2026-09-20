/**
 * testdata/trust-yes: durable test fixture. Answers the project_trust event
 * with an extension-side trust decision, remembering it in the trust store.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function registerTrustYesFixture(pi: ExtensionAPI) {
	pi.on("project_trust", () => ({ trusted: "yes", remember: true }));
}
