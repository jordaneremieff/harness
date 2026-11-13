import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { replacePrivateFile } from "./files.ts";
import { failure, GoogleError, ok, type Result } from "./result.ts";

export type SendRecord = {
	operationId: string;
	account: string;
	tool: "gmail_send" | "gmail_draft_send" | "gmail_forward";
	requestFingerprint: string;
	rfcMessageId: string;
	draftId?: string;
	draftMessageId?: string;
	state: "in_flight" | "accepted" | "rejected" | "unknown";
	gmailMessageId?: string;
	threadId?: string;
	createdAt: string;
	updatedAt: string;
	error?: { code: string; message: string; retryable: boolean };
};

function validRecord(value: unknown): value is SendRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.operationId === "string" &&
		typeof record.account === "string" &&
		(record.tool === "gmail_send" || record.tool === "gmail_draft_send" || record.tool === "gmail_forward") &&
		typeof record.requestFingerprint === "string" &&
		typeof record.rfcMessageId === "string" &&
		["in_flight", "accepted", "rejected", "unknown"].includes(String(record.state)) &&
		typeof record.createdAt === "string" &&
		typeof record.updatedAt === "string"
	);
}

export function receipt(record: SendRecord) {
	return {
		operationId: record.operationId,
		outcome: record.state,
		rfcMessageId: record.rfcMessageId,
		...(record.gmailMessageId ? { gmailMessageId: record.gmailMessageId } : {}),
		...(record.threadId ? { threadId: record.threadId } : {}),
		...(record.draftId ? { draftId: record.draftId } : {}),
		...(record.draftMessageId ? { draftMessageId: record.draftMessageId } : {}),
	};
}

/** Every send result carries the receipt, so a rejected or unknown outcome still names its RFC Message-ID. */
export function recordResult(record: SendRecord): Result<unknown> {
	if (record.state === "accepted") return ok(receipt(record));
	const error =
		record.state === "rejected"
			? new GoogleError(
					record.error?.code ?? "SEND_REJECTED",
					record.error?.message ?? "Gmail rejected the send.",
					record.error?.retryable ?? false,
					undefined,
					record.operationId,
				)
			: new GoogleError(
					"SEND_OUTCOME_UNKNOWN",
					"The send outcome is unknown. Reconcile this operation against Sent before any new send.",
					true,
					undefined,
					record.operationId,
				);
	return { ...failure(error), data: receipt(record) };
}

export class SendLedger {
	readonly path: string;
	readonly account: string;
	constructor(dir: string, account: string) {
		this.path = join(dir, "send-ledger.json");
		this.account = account;
	}

	async records(): Promise<SendRecord[]> {
		let value: unknown;
		try {
			value = JSON.parse(await readFile(this.path, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			if (error instanceof SyntaxError)
				throw new GoogleError("LEDGER_ERROR", "The send ledger is malformed. Refusing any send.");
			throw error;
		}
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			(value as Record<string, unknown>).version !== 1 ||
			!Array.isArray((value as Record<string, unknown>).records)
		) {
			throw new GoogleError("LEDGER_ERROR", "The send ledger has an invalid envelope. Refusing any send.");
		}
		const records = (value as Record<string, unknown>).records as unknown[];
		if (!records.every(validRecord))
			throw new GoogleError("LEDGER_ERROR", "The send ledger contains an invalid record. Refusing any send.");
		return records.map((record) =>
			record.state === "in_flight" ? { ...record, state: "unknown", updatedAt: new Date().toISOString() } : record,
		);
	}

	private async write(records: SendRecord[]): Promise<void> {
		await replacePrivateFile(this.path, Buffer.from(JSON.stringify({ version: 1, records }, null, 2), "utf8"));
	}

	async get(operationId: string): Promise<SendRecord | undefined> {
		return (await this.records()).find((record) => record.operationId === operationId);
	}

	async unresolved(fingerprint: string, tool?: SendRecord["tool"]): Promise<SendRecord | undefined> {
		return (await this.records()).find(
			(record) =>
				record.requestFingerprint === fingerprint &&
				record.account.toLowerCase() === this.account.toLowerCase() &&
				(!tool || record.tool === tool) &&
				(record.state === "unknown" || record.state === "in_flight"),
		);
	}

	async insert(record: SendRecord): Promise<void> {
		const records = await this.records();
		if (records.some((item) => item.operationId === record.operationId))
			throw new GoogleError(
				"OPERATION_CONFLICT",
				"The operation ID already exists.",
				false,
				undefined,
				record.operationId,
			);
		records.push(record);
		await this.write(records);
	}

	async update(record: SendRecord): Promise<void> {
		const records = await this.records();
		const index = records.findIndex((item) => item.operationId === record.operationId);
		if (index < 0)
			throw new GoogleError("LEDGER_ERROR", `Send operation ${record.operationId} is absent from the ledger.`);
		records[index] = { ...record, updatedAt: new Date().toISOString() };
		await this.write(records);
	}
}
