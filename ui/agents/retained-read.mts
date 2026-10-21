import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { AgentError } from "./client.mts";
import { assertOperation, ContractError, decodeRetainedDescriptor, decodeRetainedParams, decodeRetainedResponse,
  type RetainedMethod, type Responses } from "./contract.mts";

export interface RetainedReadOptions {
  store: string;
  reader: () => Promise<string>;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  timeoutMs?: number;
  outputBytes?: number;
  stderrBytes?: number;
}
const RESPONSE_BYTES = 16 * 1024 * 1024;
const REQUEST_BYTES = 65536;
function processJson(chunks: Buffer[], length: number): unknown {
  try {
    const text = new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks,length));
    if (!text.endsWith("\n")) throw new Error("Missing response terminator");
    return JSON.parse(text);
  } catch {throw new AgentError("protocol_error","The retained reader response is not a complete JSON envelope.");}
}
/** One request owns its descriptor/read children. No host launch, source access, or retry exists here. */
export class RetainedReader {
  readonly #options: RetainedReadOptions;
  readonly #active = new Map<AbortController, Promise<unknown>>();
  #closed = false;
  constructor(options: RetainedReadOptions) {
    for (const [value, max] of [[options.timeoutMs ?? 30000, 30000], [options.outputBytes ?? RESPONSE_BYTES, RESPONSE_BYTES], [options.stderrBytes ?? 65536, 65536]])
      if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new AgentError("invalid_request", "Invalid retained reader bound.");
    this.#options = options;
  }
  request<M extends RetainedMethod>(method: M, identity: string, input: unknown, signal?: AbortSignal): Promise<Responses[M]> {
    if (this.#closed) return Promise.reject(new AgentError("not_ready", "The retained reader is closed."));
    if (this.#active.size >= 4) return Promise.reject(new AgentError("capacity", "Retained read capacity reached."));
    const controller = new AbortController();
    const cancel = () => controller.abort(new AgentError("cancelled", "The retained read was cancelled."));
    signal?.addEventListener("abort", cancel, {once:true});
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new AgentError("timeout", "The retained read exceeded its deadline.", false, true)), this.#options.timeoutMs ?? 30000);
    const job = this.#read(method, identity, input, controller.signal).catch(error => {
      if (error instanceof AgentError) throw error;
      if (error instanceof ContractError) throw new AgentError(error.code === "incompatible" ? method.startsWith('collaboration-') ? "threads_unavailable" : "contract_mismatch" : "protocol_error", error.message);
      throw new AgentError("host_unavailable", "The retained reader is unavailable.", false, true);
    }).finally(() => {clearTimeout(timer);signal?.removeEventListener("abort",cancel);this.#active.delete(controller);});
    this.#active.set(controller, job);
    return job as Promise<Responses[M]>;
  }
  async #read(method: RetainedMethod, identity: string, input: unknown, signal: AbortSignal): Promise<Responses[RetainedMethod]> {
    signal.throwIfAborted();
    let params: ReturnType<typeof decodeRetainedParams>;
    try {params = decodeRetainedParams(method, input, identity);}
    catch {throw new AgentError("invalid_request", "The retained target or read parameters are invalid.");}
    const store = resolve(this.#options.store);
    if (store.length > 4096 || /[\x00-\x1f\x7f-\x9f]/.test(store)) throw new AgentError("invalid_request", "Invalid retained store path.");
    // Validate request size before the descriptor or executable path is accessed.
    const id = `ui-retained:${randomUUID()}`;
    const envelope = {version:"retained-read/1.0.0",id,store,sessionId:identity,method,expected:{},params};
    if (Buffer.byteLength(JSON.stringify(envelope)) > REQUEST_BYTES - 1024) throw new AgentError("limit_exceeded", "The retained request exceeds its byte bound.");
    const path = await this.#options.reader();
    signal.throwIfAborted();
    if (!isAbsolute(path) || path.length > 4096 || /[\x00-\x1f\x7f-\x9f]/.test(path)) throw new AgentError("invalid_request", "Invalid retained reader path.");
    const collaboration = method === "collaboration-list" || method === "collaboration-read";
    const descriptor = await this.#process(path,collaboration ? ["--contract", "collaboration"] : ["--contract"],undefined,signal);
    if (descriptor.code !== 0) throw new AgentError("host_unavailable", "The retained reader descriptor failed.", false, true);
    envelope.expected = assertOperation(decodeRetainedDescriptor(descriptor.value, collaboration), method);
    const request = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(request) > REQUEST_BYTES) throw new AgentError("limit_exceeded", "The retained request exceeds its byte bound.");
    const response = await this.#process(path,[],request,signal);
    const decoded = decodeRetainedResponse(method,response.value,id,identity,params);
    if (response.code !== (decoded.ok ? 0 : 1)) throw new AgentError("protocol_error", "The retained reader exit code disagrees with its response.");
    if (!decoded.ok) throw new AgentError(decoded.error.code,decoded.error.message,false,decoded.error.retryable);
    return decoded.result;
  }
  #process(path: string, args: string[], input: string | undefined, signal: AbortSignal): Promise<{code: number | null; value: unknown}> {
    signal.throwIfAborted();
    return new Promise((done, reject) => {
      let child: ChildProcess;
      try {child = (this.#options.spawn ?? spawn)(process.execPath,[path,...args],{cwd:dirname(path),shell:false,detached:false,stdio:["pipe","pipe","pipe"]});}
      catch {reject(new AgentError("host_unavailable","The retained reader could not start.",false,true));return;}
      let length = 0, stderr = 0;
      const chunks: Buffer[] = [];
      let failure: Error | undefined;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const stop = (error: Error) => {
        if (failure) return;
        failure = error;
        child.kill("SIGTERM");
        escalation = setTimeout(() => child.kill("SIGKILL"),1000);
      };
      const cancel = () => stop(signal.reason instanceof Error ? signal.reason : new AgentError("cancelled","The retained read was cancelled."));
      signal.addEventListener("abort",cancel,{once:true});
      child.stdout?.on("data",(value: Buffer) => {
        length += value.length;
        if (length > (this.#options.outputBytes ?? RESPONSE_BYTES)) stop(new AgentError("limit_exceeded","The retained response exceeds its byte bound."));
        else if (!failure) chunks.push(Buffer.from(value));
      });
      child.stderr?.on("data",(value: Buffer) => {
        stderr += value.length;
        if (stderr > (this.#options.stderrBytes ?? 65536)) stop(new AgentError("limit_exceeded","The retained reader diagnostic output exceeds its bound."));
      });
      const streamFailure = () => stop(new AgentError("host_unavailable","The retained reader pipe failed.",false,true));
      child.stdin?.on("error",streamFailure);child.stdout?.on("error",streamFailure);child.stderr?.on("error",streamFailure);
      child.once("error",() => stop(new AgentError("host_unavailable","The retained reader executable is unavailable.",false,true)));
      child.once("close",(code,exitSignal) => {
        signal.removeEventListener("abort",cancel);if(escalation) clearTimeout(escalation);
        if (failure) {reject(failure);return;}
        if (exitSignal || code === null) {reject(new AgentError("host_unavailable","The retained reader exited without a response.",false,true));return;}
        try {done({code,value:processJson(chunks,length)});}
        catch (error) {reject(error);}
      });
      if (!child.stdin || !child.stdout || !child.stderr) stop(new AgentError("host_unavailable","The retained reader pipes are unavailable.",false,true));
      if (signal.aborted) cancel();
      child.stdin?.end(input);
    });
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#active.keys()) controller.abort(new AgentError("cancelled","The UI closed the retained read."));
    await Promise.allSettled([...this.#active.values()]);
  }
}
