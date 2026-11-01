import assert from "node:assert/strict";
import { it } from "node:test";
import { OutputTail } from "./output-tail.ts";
import { JOB_LIMITS, JobManager } from "./manager.ts";

it("matches exact binary tail retention across capacities and chunk boundaries", () => {
	for (const capacity of [1, 2, 7, 256, JOB_LIMITS.logBytes]) {
		const tail = new OutputTail(capacity);
		let reference = Buffer.alloc(0), state = 17;
		for (let turn = 0; turn < 80; turn += 1) {
			state = (Math.imul(state, 1103515245) + 12345) >>> 0;
			const data = Buffer.alloc(state % (capacity * 2 + 1));
			for (let byte = 0; byte < data.length; byte += 1) data[byte] = (byte + turn) & 255;
			reference = Buffer.concat([reference, data]).subarray(-capacity);
			tail.append(data);
			assert.deepEqual(tail.read(), reference);
			assert.equal(tail.length, reference.length);
			const independent = tail.read(); independent.fill(0);
			assert.deepEqual(tail.read(), reference);
		}
	}
});

it("copies only input and bounded read materialisation in the manager workload", async (t) => {
	const original = Buffer.prototype.copy;
	let copiedBytes = 0;
	const mocked = t.mock.method(Buffer.prototype, "copy", function (this: Buffer, ...args: Parameters<Buffer["copy"]>) {
		const copied = original.apply(this, args);
		copiedBytes += copied;
		return copied;
	});
	const manager = new JobManager();
	try {
		const inputBytes = 16 * 1024 * 1024, chunkBytes = 1024;
		const chunk = Buffer.alloc(chunkBytes, 120);
		const job = manager.start("synthetic", "/", { exec: async (_command, _cwd, execution) => {
			for (let received = 0; received < inputBytes; received += chunkBytes) execution.onData(chunk);
			return { exitCode: 0 };
		} });
		await manager.wait(job.id);
		assert.equal(copiedBytes, inputBytes);
		const page = manager.logs(job.id);
		assert.equal(page.earliest, inputBytes - JOB_LIMITS.logBytes);
		assert.equal(page.text, "x".repeat(JOB_LIMITS.pageBytes));
		assert.equal(copiedBytes, inputBytes + JOB_LIMITS.logBytes);
		let referenceCopies = 0;
		for (let received = chunkBytes; received <= inputBytes; received += chunkBytes) referenceCopies += Math.min(received, JOB_LIMITS.logBytes);
		assert.equal(referenceCopies, 4_261_543_936);
		t.diagnostic(JSON.stringify({ inputBytes, chunkBytes, retainedBytes: JOB_LIMITS.logBytes, appendCopiedBytes: copiedBytes - JOB_LIMITS.logBytes, readCopiedBytes: JOB_LIMITS.logBytes, previousAppendCopiedBytes: referenceCopies }));
	} finally { mocked.mock.restore(); await manager.dispose(); }
});
