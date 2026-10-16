/** Private supervisor/backend transport. This module has no runtime imports. */
export const OWNER_PROTOCOL = 'ui.primary-owner/1' as const;
export const OWNER_LIMITS = {
  primaries: 4, pending: 64, outcomes: 2048, outcomeBytes: 64 * 1024 * 1024,
  recordBytes: 32 * 1024 * 1024, decodeBytes: 64 * 1024 * 1024,
  ringRecords: 4096, ringBytes: 8 * 1024 * 1024,
  tapeRecords: 32768, tapeBytes: 16 * 1024 * 1024,
  toolSlots: 64, slotBytes: 8 * 1024 * 1024,
  dialogs: 16, dialogBytes: 128 * 1024,
  inputBytes: 12 * 1024 * 1024, prepared: 1,
  captureBytes: 40 * 1024 * 1024, capturePageBytes: 192 * 1024,
  recoveryRecords: 128, recoveryBytes: 64 * 1024 * 1024,
  queueBytes: 1024 * 1024, queueItems: 128, stderrBytes: 64 * 1024,
} as const;
export type OwnerLimits = {[K in keyof typeof OWNER_LIMITS]: number};
export type OwnerJson = null | boolean | number | string | OwnerJson[] | {[key: string]: OwnerJson};
export type OwnerRecord = {type: string; [key: string]: OwnerJson | undefined};
export type OwnerStateIdentity = {root: string; instanceId: string};
export type OwnerPrimary = {key: string; epoch: number; cwd: string; executable: string;
  sessionFile?: string; recoveryWorkspaceId: string};
export type OwnerDescriptor = OwnerPrimary & {pid?: number; exited: boolean; available: boolean;
  synchronized: boolean; sequence: number; stderr: string; recoveryPending: boolean};
export type OwnerMutation = {operationId: string; digest: string; step: string};
export type OwnerQueueReservation = {id: string; workspaceId: string; pendingCount: number};
/** messageStartSequence links an assistant end to its observed start without changing the wire record. */
export type OwnerEvent = {seq: number; at: number; record: OwnerRecord; messageStartSequence?: number};
export type OwnerDialog = {event: OwnerEvent; expiresAt?: number};
export type OwnerBaseline = {descriptor: OwnerDescriptor; from: number; cursor: number; complete: boolean;
  reasons: string[]; overlap: OwnerEvent[]; activeMessage: {startSequence: number; complete: boolean; events: OwnerEvent[]} | null;
  tools: {callId: string; start: OwnerEvent; latest?: OwnerEvent}[];
  state: OwnerEvent[]; dialogs: OwnerDialog[]};
export type OwnerCapture = {token: string; from: number; cursor: number; complete: boolean;
  reasons: string[]; bytes: number; pages: number};
export type OwnerCapturePage = {token: string; index: number; encoding: 'base64'; data: string};
export type OwnerOutcome = {id: string; primaryKey: string; epoch: number; command: string;
  mutation?: OwnerMutation; state: 'prepared' | 'pending' | 'complete' | 'uncertain' | 'refused';
  written: boolean; response?: OwnerRecord; error?: string; sequence?: number};
export type OwnerRecovery = {format: 'ui.owner-recovery/1'; state: OwnerStateIdentity;
  ownerIncarnation: string; id: string; primary: OwnerPrimary; workspaceId: string;
  pendingCount: number; status: 'reserved' | 'returned' | 'uncertain'; response?: OwnerRecord};
export type OwnerError = {code: string; message: string; uncertain: boolean};
export type OwnerReply = {ok: true; value: unknown} | {ok: false; error: OwnerError};
export type OwnerHello = {protocol: typeof OWNER_PROTOCOL; ownerIncarnation: string;
  state: OwnerStateIdentity; attachmentId: string; mutator: boolean; primaries: OwnerDescriptor[];
  capabilities?: ('capture-resynchronize/1')[]};
export type OwnerNotice = {kind: 'record'; primaryKey: string; epoch: number; event: OwnerEvent} |
  {kind: 'resync'; primaryKey: string; reason: string} |
  {kind: 'exit'; primaryKey: string; epoch: number; descriptor: OwnerDescriptor};
type Address = {primaryKey: string; epoch: number};
export type OwnerAction =
  | {kind: 'hello'}
  | {kind: 'open'; primary: OwnerPrimary}
  | ({kind: 'command'; record: OwnerRecord; mutation?: OwnerMutation; recovery?: OwnerQueueReservation} & Address)
  | ({kind: 'prepare'; mutation: OwnerMutation; bytes: number} & Address)
  | ({kind: 'prepared'; id: string; line: string} & Address)
  | ({kind: 'ui-response'; record: OwnerRecord} & Address)
  | ({kind: 'capture-begin'} & Address)
  /** Backend attests a verified full native refresh since capture-begin; the capture must remain unsealed. */
  | ({kind: 'resynchronize'; token: string} & Address)
  | ({kind: 'capture-finish'; token: string} & Address)
  | ({kind: 'capture-page'; token: string; index: number} & Address)
  | ({kind: 'capture-ack'; token: string} & Address)
  | ({kind: 'outcome'; id?: string; mutation?: OwnerMutation} & Address)
  | ({kind: 'ack'; id: string} & Address)
  | ({kind: 'operation-complete'; mutation: OwnerMutation; result: OwnerJson} & Address)
  | ({kind: 'operation-result'; operationId: string; digest: string} & Address)
  | ({kind: 'epoch'; next: number; sessionFile?: string} & Address)
  | ({kind: 'close-primary'; timeoutMs?: number} & Address)
  | {kind: 'recoveries'}
  | {kind: 'recovery-ack'; id: string}
  | {kind: 'detach'};
export type OwnerRequest = OwnerAction & {protocol: typeof OWNER_PROTOCOL; ownerIncarnation: string; requestId: string};
