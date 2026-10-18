import { parentPort, workerData } from "node:worker_threads";
import { nativeImage } from "./images.mts";
import { AgentError } from "./client.mts";
import { AgentService, type CommandInput, type HistoryOptions, type InspectOptions, type SubmitInput, type ThreadListOptions, type ThreadReadOptions } from "./service-runtime.mts";
import { transferFrame, transferInspect, transferSnapshot, transferThread } from "./transfer.mts";

interface Request { id: number; member: string; args: unknown[] }
const port = parentPort;
if (!port) throw new Error("Agent service worker requires a parent port.");
const service = new AgentService({ store: workerData.store, stateDir: workerData.stateDir, installationId: workerData.installationId, agentDir: workerData.agentDir,
  onImageInput: (...args) => port.postMessage({ event: "imageInput", args }),
  frameProjection: transferFrame,
  onRoster: page => port.postMessage({ event: "roster", args: [page] }),
  onFrame: (workspace, identity, epoch, frame) => port.postMessage({ event: "frame", args: [workspace, identity, epoch, frame] }),
  onAvailability: (...args) => port.postMessage({ event: "availability", args }),
});
let closing = false;
let pending = 0;
const reads = new Map<number, AbortController>();
function errorValue(error: unknown): { code: string; message: string; uncertain: boolean; retryable: boolean } {
  const value = error && typeof error === "object" ? error : {};
  const code = "code" in value && typeof value.code === "string" ? value.code : "internal";
  return { code, message: error instanceof Error ? error.message.slice(0, 2000) : "Agent worker request failed.",
    uncertain: "uncertain" in value && value.uncertain === true, retryable: "retryable" in value && value.retryable === true };
}
async function invoke(member: string, args: unknown[], signal?: AbortSignal): Promise<unknown> {
  const identity = args[0] as string;
  switch (member) {
    case "refresh": return service.refresh(args[0] as string | undefined);
    case "select": return service.select(identity, args[1] as string | undefined, args[2] as number | undefined);
    case "hide": return service.hide(identity, args[1] as string | undefined);
    case "reconnect": return service.reconnect(identity, args[1] as string, args[2] as number | undefined);
    case "disconnectWorkspace": return service.disconnectWorkspace(identity);
    case "prepare": return service.prepare(identity);
    case "history": return transferSnapshot(await service.history(identity, args[1] as HistoryOptions, signal));
    case "image": return nativeImage(service, identity, args[1], args[2]);
    case "inspect": return transferInspect(await service.inspect(identity, args[1] as InspectOptions, signal));
    case "threads": return transferThread(await service.threads(identity, args[1] as ThreadListOptions, signal));
    case "thread": return transferThread(await service.thread(identity, args[1] as string, args[2] as ThreadReadOptions, signal));
    case "submit": return service.submit(identity, args[1] as SubmitInput);
    case "retrySubmit": return service.retrySubmit(identity, args[1] as SubmitInput);
    case "abort": return service.abort(identity);
    case "inventory": return service.inventory(identity, signal);
    case "command": return service.command(identity, args[1] as CommandInput);
    case "close": closing = true; return service.close();
    default: throw new AgentError("invalid_request", "Unsupported agent worker operation.");
  }
}
port.on("message", (request: Request) => {
  if (!request || !Number.isSafeInteger(request.id) || !Array.isArray(request.args)) return;
  if (request.member === "cancel") {reads.get(request.id)?.abort();return;}
  if (closing || (pending >= 64 && request.member !== "close")) {
    port.postMessage({ id: request.id, error: errorValue(new AgentError(closing ? "not_ready" : "capacity", "Agent worker does not accept this request.")) });
    return;
  }
  pending++;
  const controller = ["history", "inspect", "threads", "thread", "inventory"].includes(request.member) ? new AbortController() : undefined;
  if (controller) reads.set(request.id,controller);
  void invoke(request.member, request.args, controller?.signal).then(result => port.postMessage({ id: request.id, result }),
    error => port.postMessage({ id: request.id, error: errorValue(error) })).finally(() => {
    pending--;reads.delete(request.id);
    if (closing && pending === 0) port.close();
  });
});
port.postMessage({ event: "ready", args: [] });
