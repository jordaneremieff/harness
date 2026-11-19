import { stdin, stdout } from "node:process";
import { absoluteStorePath, NotesError, NotesStore } from "./notes-store.ts";
import { resolveRepository } from "./repository.ts";

const MAX_REQUEST = 1024 * 1024;
const MAX_RESPONSE = 16 * MAX_REQUEST;

async function readRequest() {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of stdin) {
		length += chunk.length;
		if (length > MAX_REQUEST) throw new NotesError("invalid", "The Explorer notes request exceeds its size limit.");
		chunks.push(chunk);
	}
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)));
	} catch {
		throw new NotesError("invalid", "The Explorer notes request is not valid JSON.");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new NotesError("invalid", "An Explorer notes request must be an object.");
	const { version, store, root, op, ...fields } = value as Record<string, unknown>;
	if (version !== 1 || !absoluteStorePath(store) || !absoluteStorePath(root) || typeof op !== "string")
		throw new NotesError("invalid", "The Explorer notes request requires version 1, absolute paths and an operation.");
	return { store, root, op, fields };
}

async function reply() {
	try {
		const { store, root, op, fields } = await readRequest();
		const repo = await resolveRepository(root).catch(() => {
			throw new NotesError("invalid", "The Explorer root must be an accessible directory.");
		});
		const data = JSON.stringify({ ok: true, ...(await new NotesStore(store, repo).request(op, fields)) });
		if (Buffer.byteLength(data) + 1 > MAX_RESPONSE)
			throw new NotesError("store-failure", "The Explorer notes response exceeds its size limit.");
		return data;
	} catch (error) {
		return JSON.stringify({
			ok: false,
			error:
				error instanceof NotesError
					? { code: error.code, message: error.message }
					: { code: "store-failure", message: "The Explorer store operation failed." },
		});
	}
}

stdout.write(`${await reply()}\n`);
