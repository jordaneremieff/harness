import { randomUUID } from "node:crypto";

export interface PeerEnvelope {
	id: string;
	from: string;
	to: string;
	replyTo: string | null;
	sentAt: number;
	message: string;
}
export interface PeerReceipt extends Omit<PeerEnvelope, "message"> {
	status: "sent_unconfirmed" | "context_seen" | "target_closed";
}
export interface PeerRegistration {
	sessionId: string;
	workerId?: string;
	parentSessionId: string | null;
	label: string;
	send: (envelope: PeerEnvelope) => void;
}
interface Peer extends PeerRegistration {
	pending: Set<string>;
}
export interface PeerWaitResult {
	status: "message" | "timeout" | "closed";
	messages: PeerReceipt[];
}

/** Process-local routing only. Pi owns message persistence and agent execution. */
export class PeerHub {
	private peers = new Map<string, Peer>();
	private receipts = new Map<string, PeerReceipt>();
	private waiters = new Map<string, (result: PeerWaitResult) => void>();

	register(registration: PeerRegistration): () => void {
		if (!registration.sessionId || registration.sessionId.length > 200)
			throw new Error("Invalid peer session identity");
		if (!this.peers.has(registration.sessionId) && this.peers.size >= 128) throw new Error("Peer directory is full");
		const previous = this.peers.get(registration.sessionId);
		const peer = {
			...registration,
			label: registration.label.slice(0, 240),
			pending: previous?.pending ?? new Set<string>(),
		};
		this.peers.set(peer.sessionId, peer);
		return () => {
			if (this.peers.get(peer.sessionId) !== peer) return;
			this.peers.delete(peer.sessionId);
			for (const id of peer.pending) {
				const receipt = this.receipts.get(id);
				if (receipt?.status === "sent_unconfirmed") receipt.status = "target_closed";
			}
			this.waiters.get(peer.sessionId)?.({ status: "closed", messages: [] });
		};
	}

	private address(peer: Peer): string {
		return peer.workerId ?? peer.sessionId;
	}
	private requirePeer(sessionId: string): Peer {
		const peer = this.peers.get(sessionId);
		if (!peer) throw new Error("This session is not an available collaboration peer");
		return peer;
	}
	private root(peer: Peer): string | null {
		const visited = new Set<string>();
		while (peer.parentSessionId !== null) {
			if (visited.has(peer.sessionId)) return null;
			visited.add(peer.sessionId);
			const parent = this.peers.get(peer.parentSessionId);
			if (!parent) return null;
			peer = parent;
		}
		return peer.sessionId;
	}
	list(sessionId: string, offset = 0) {
		const self = this.requirePeer(sessionId);
		const root = this.root(self);
		if (!root) throw new Error("This peer's dispatch family is no longer available");
		if (!Number.isInteger(offset) || offset < 0 || offset > 128)
			throw new Error("Peer offset must be between 0 and 128");
		const family = [...this.peers.values()].filter((peer) => this.root(peer) === root);
		return {
			self: this.address(self),
			total: family.length,
			offset,
			nextOffset: offset + 32 < family.length ? offset + 32 : null,
			peers: family.slice(offset, offset + 32).map((peer) => ({
				id: this.address(peer),
				parent: peer.parentSessionId ? this.address(this.requirePeer(peer.parentSessionId)) : null,
				label: peer.label,
				waiting: this.waiters.has(peer.sessionId),
			})),
		};
	}

	send(sessionId: string, to: string, message: string, replyTo?: string): PeerReceipt {
		const sender = this.requirePeer(sessionId);
		if (!message.trim() || Buffer.byteLength(message, "utf8") > 8192 || message.split("\n").length > 256) {
			throw new Error("Peer message must contain text within 8192 UTF-8 bytes and 256 lines; nothing was sent");
		}
		const recipient =
			to === "parent"
				? this.peers.get(sender.parentSessionId ?? "")
				: [...this.peers.values()].find((peer) => this.address(peer) === to);
		if (!recipient) throw new Error("Peer is unavailable; use subagent_peers for current addresses");
		if (sender === recipient) throw new Error("A peer message requires another session");
		const root = this.root(sender);
		if (!root || this.root(recipient) !== root)
			throw new Error("Peer messages stay inside the caller's dispatch family");
		const from = this.address(sender);
		const target = this.address(recipient);
		if (replyTo) {
			const original = this.receipts.get(replyTo);
			if (!original || original.from !== target || original.to !== from)
				throw new Error("replyTo must name a message from this recipient to this sender");
		}
		if (recipient.pending.size >= 128) throw new Error("Peer has too many unconfirmed messages; nothing was sent");
		if (this.receipts.size >= 512) {
			const evict = [...this.receipts].find(([, receipt]) => receipt.status !== "sent_unconfirmed");
			if (!evict) throw new Error("Peer receipt capacity is full; nothing was sent");
			this.receipts.delete(evict[0]);
		}
		const envelope: PeerEnvelope = {
			id: `pm-${randomUUID()}`,
			from,
			to: target,
			replyTo: replyTo ?? null,
			sentAt: Date.now(),
			message,
		};
		const { message: _message, ...metadata } = envelope;
		const receipt: PeerReceipt = { ...metadata, status: "sent_unconfirmed" };
		this.receipts.set(receipt.id, receipt);
		recipient.pending.add(receipt.id);
		try {
			recipient.send(envelope);
		} catch (error) {
			this.receipts.delete(receipt.id);
			recipient.pending.delete(receipt.id);
			throw error;
		}
		this.waiters.get(recipient.sessionId)?.({ status: "message", messages: [{ ...receipt }] });
		return { ...receipt };
	}

	status(sessionId: string, id: string): PeerReceipt {
		const self = this.address(this.requirePeer(sessionId));
		const receipt = this.receipts.get(id);
		if (!receipt || (receipt.from !== self && receipt.to !== self))
			throw new Error(
				"No retained peer receipt for this session and message. This bounded, process-local lookup cannot determine whether the message was delivered or processed. It does not inspect the recipient transcript or other durable evidence.",
			);
		return { ...receipt };
	}

	/** This observes context construction, not model understanding or disk flush. */
	observeContext(sessionId: string, ids: readonly string[]): void {
		const peer = this.peers.get(sessionId);
		if (!peer) return;
		for (const id of ids) {
			const receipt = this.receipts.get(id);
			if (!receipt || receipt.to !== this.address(peer)) continue;
			receipt.status = "context_seen";
			peer.pending.delete(id);
		}
	}

	wait(sessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<PeerWaitResult> {
		const peer = this.requirePeer(sessionId);
		if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
			throw new Error("Wait timeout must be between 1 and 300000 milliseconds");
		if (signal?.aborted) return Promise.reject(new Error("Peer wait aborted"));
		if (this.waiters.has(sessionId)) throw new Error("This session already has a peer wait");
		if (peer.pending.size)
			return Promise.resolve({
				status: "message",
				messages: [...peer.pending].map((id) => ({ ...this.receipts.get(id)! })),
			});
		return new Promise((resolve, reject) => {
			const finish = (result: PeerWaitResult) => {
				cleanup();
				resolve(result);
			};
			const abort = () => {
				cleanup();
				reject(new Error("Peer wait aborted"));
			};
			const timer = setTimeout(() => finish({ status: "timeout", messages: [] }), timeoutMs);
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				if (this.waiters.get(sessionId) === finish) this.waiters.delete(sessionId);
			};
			this.waiters.set(sessionId, finish);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}
}
