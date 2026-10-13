import { LIMITS } from "../shared/api.ts";
import { AgentError } from "./input.mts";

interface ByteTransport { send(chunk: Uint8Array): Promise<void>; close(): void }
export interface SendAttempt<T> { promise: Promise<T>; refused?: AgentError }
/** Counts complete native frames, including every control frame, until writes settle. */
export class FramedTransportBudget {
  #pending = 0;
  #active?: { refused?: AgentError };
  capture<T>(send: () => Promise<T>): SendAttempt<T> {
    const marker: {refused?: AgentError} = {};
    const previous = this.#active; this.#active = marker;
    try { const promise = send(); return {promise, ...marker}; } finally { this.#active = previous; }
  }
  wrap(transport: ByteTransport): ByteTransport {
    return {close: () => transport.close(), send: chunk => this.#send(transport, chunk)};
  }
  #send(transport: ByteTransport, chunk: Uint8Array): Promise<void> {
    const error = chunk.byteLength > LIMITS.inputFrameBytes
      ? new AgentError("payload_too_large", "The complete native frame exceeds the input bound.")
      : this.#pending + chunk.byteLength > LIMITS.agentPendingBytes
        ? new AgentError("capacity", "Native transport pending bytes exceed the bound.") : undefined;
    if (error) {
      if (this.#active) this.#active.refused = error;
      return Promise.reject(error);
    }
    this.#pending += chunk.byteLength;
    try { return transport.send(chunk).finally(() => { this.#pending -= chunk.byteLength; }); }
    catch (error) { this.#pending -= chunk.byteLength; return Promise.reject(error); }
  }
}
