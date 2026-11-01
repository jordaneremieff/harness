/** Fixed-capacity byte retention. Appends copy new bytes, never the retained prefix. */
export class OutputTail {
	private storage: Buffer | undefined;
	private start = 0;
	private used = 0;
	readonly capacity: number;

	constructor(capacity: number) {
		if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error("Invalid output capacity");
		this.capacity = capacity;
	}

	get length(): number { return this.used; }

	append(input: Buffer): void {
		if (input.length === 0) return;
		let storage = this.storage;
		if (storage === undefined) {
			storage = Buffer.allocUnsafe(this.capacity);
			this.storage = storage;
		}
		const retained = input.subarray(Math.max(0, input.length - this.capacity));
		const overflow = Math.max(0, this.used + retained.length - this.capacity);
		this.start = (this.start + overflow) % this.capacity;
		this.used -= overflow;
		const destination = (this.start + this.used) % this.capacity;
		const first = Math.min(retained.length, this.capacity - destination);
		retained.copy(storage, destination, 0, first);
		if (first < retained.length) retained.copy(storage, 0, first);
		this.used += retained.length;
	}

	/** Return independent contiguous bytes for one reader. */
	read(): Buffer {
		const output = Buffer.allocUnsafe(this.used);
		if (!this.storage || this.used === 0) return output;
		const first = Math.min(this.used, this.capacity - this.start);
		this.storage.copy(output, 0, this.start, this.start + first);
		if (first < this.used) this.storage.copy(output, first, 0, this.used - first);
		return output;
	}
}
