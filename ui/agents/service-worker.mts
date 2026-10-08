import { parentPort, workerData } from "node:worker_threads";
import { AgentError } from "./client.mts";
import { AgentService, type HistoryOptions, type InspectOptions, type SubmitInput } from "./service-runtime.mts";
import { transferFrame, transferInspect, transferSnapshot } from "./transfer.mts";

interface Request { id: number; member: string; args: unknown[] }
const port = parentPort;
if (!port) throw new Error("Agent service worker requires a parent port.");
const service = new AgentService({ store: workerData.store, installationId: workerData.installationId,
  frameProjection: transferFrame,
  onRoster: page => port.postMessage({ event: "roster", args: [page] }),
  onFrame: (workspace, identity, epoch, frame) => port.postMessage({ event: "frame", args: [workspace, identity, epoch, frame] }),
  onAvailability: (...args) => port.postMessage({ event: "availability", args }),
});
let closing = false;
let pending = 0;
function errorValue(error: unknown): { code: string; message: string; uncertain: boolean } {
  const value = error && typeof error === "object" ? error : {};
  const code = "code" in value && typeof value.code === "string" ? value.code : "internal";
  return { code, message: error instanceof Error ? error.message.slice(0, 2000) : "Agent worker request failed.",
    uncertain: "uncertain" in value && value.uncertain === true };
}
async function invoke(member: string, args: unknown[]): Promise<unknown> {
  const identity = args[0] as string;
  switch (member) {
    case "refresh": return service.refresh(args[0] as string | undefined);
    case "select": return service.select(identity, args[1] as string | undefined);
    case "hide": return service.hide(identity);
    case "reconnect": return service.reconnect(identity);
    case "disconnectWorkspace": return service.disconnectWorkspace(identity);
    case "history": return transferSnapshot(await service.history(identity, args[1] as HistoryOptions));
    case "inspect": return transferInspect(await service.inspect(identity, args[1] as InspectOptions));
    case "submit": return service.submit(identity, args[1] as SubmitInput);
    case "retrySubmit": return service.retrySubmit(identity, args[1] as SubmitInput);
    case "abort": return service.abort(identity);
    case "close": closing = true; return service.close();
    default: throw new AgentError("invalid_request", "Unsupported agent worker operation.");
  }
}
port.on("message", (request: Request) => {
  if (!request || !Number.isSafeInteger(request.id) || !Array.isArray(request.args)) return;
  if (closing || (pending >= 64 && request.member !== "close")) {
    port.postMessage({ id: request.id, error: errorValue(new AgentError(closing ? "not_ready" : "capacity", "Agent worker does not accept this request.")) });
    return;
  }
  pending++;
  void invoke(request.member, request.args).then(result => port.postMessage({ id: request.id, result }),
    error => port.postMessage({ id: request.id, error: errorValue(error) })).finally(() => {
    pending--;
    if (closing && pending === 0) port.close();
  });
});
port.postMessage({ event: "ready", args: [] });
