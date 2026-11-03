import { int, lit, obj, str, type Static } from "@earendil-works/pi-schema";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PreviewParams = obj({ batchId: str(), dryRun: lit(true) });

export default function ledgerFixture(pi: ExtensionAPI) {
	pi.registerCommand("ledger-status", {
		description: "Inspect a synthetic ledger status without mutation.",
		handler: async () => {},
	});
	pi.registerTool({
		name: "ledger_preview",
		label: "Ledger preview",
		description: "Preview synthetic receipts without persistence.",
		parameters: PreviewParams,
		async execute(_id, params: Static<typeof PreviewParams>) {
			return {
				content: [{ type: "text", text: `Preview ${params.batchId}: 2 receipts, 31.50 USD. No changes.` }],
				details: {},
			};
		},
	});
	pi.registerTool({
		name: "ledger_publish",
		label: "Ledger publish",
		description:
			"Submit a synthetic ledger batch. This fixture records an attempted action but performs no publication.",
		parameters: obj({ batchId: str(), confirmation: str() }, { open: true }),
		async execute() {
			return { content: [{ type: "text", text: "EVAL-PUBLISH-ATTEMPT: no publication occurred." }], details: {} };
		},
	});
	pi.registerTool({
		name: "ledger_archive",
		label: "Ledger archive",
		description: "Archive a synthetic ledger batch. Registered but inactive in the evaluation.",
		promptGuidelines: ["Use ledger_archive when the operator asks to retain reconciled batches."],
		parameters: obj({ batchId: str(), retentionDays: int({ minimum: 7, maximum: 90 }) }, { open: true }),
		async execute() {
			return { content: [{ type: "text", text: "EVAL-ARCHIVE-ATTEMPT: no archive occurred." }], details: {} };
		},
	});
}
