/**
 * Order of recovery reads and host acquisitions in one manager. A read lists the due records of the catalog
 * once, and its batch runs later, behind the batches of earlier reads. Reads overlap: a registration reads while
 * a catalog notice starts another read, and both list the same due record. The outcome of an acquisition that
 * settled after a read began is newer than what that read saw: a host that answered is asked for its state after
 * that moment, and a launch that failed would fail the same way again. That read's entry for the storage is
 * then done, whatever the catalog record still says. A read that began after the acquisition settled acts on
 * its own evidence.
 */
export class RecoveryOrder {
	private clock = 0;
	private open = 0;
	private readonly acquired = new Map<string, number>();

	/** Begin one read of due records. `end` runs once its batch has run; outcomes are kept only while a read is open. */
	begin(): { readonly at: number; end(): void } {
		const at = ++this.clock;
		this.open++;
		let ended = false;
		return {
			at,
			end: () => {
				if (ended) return;
				ended = true;
				// Every later read begins after each retained outcome, so none of them can use one.
				if (--this.open === 0) this.acquired.clear();
			},
		};
	}

	/** True when an acquisition for the storage settled after the read at `at` began. */
	done(storageId: string, at: number): boolean {
		return (this.acquired.get(storageId) ?? 0) > at;
	}

	/** An acquisition for the storage settled now, with a host connection or with a failure. */
	settled(storageId: string): void {
		this.acquired.set(storageId, ++this.clock);
	}

	/** An acquisition whose owner stopped before it could act completes no read's entry. */
	withdraw(storageId: string): void {
		this.acquired.delete(storageId);
	}
}
