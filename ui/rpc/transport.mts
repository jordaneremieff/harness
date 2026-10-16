import type {OwnerBaseline, OwnerQueueReservation} from '../shared/owner.ts';
import type {PreparedLine, RpcClientOptions, RpcError} from './client.mts';
export interface PrimaryTransport {
  readonly child?: {pid?: number}; readonly exited: boolean; readonly available: boolean; readonly stderrTail: string; readonly pendingCount: number;
  synchronized: boolean;
  start(sessionFile?: string): void | Promise<void>;
  request(type: string, fields?: Record<string, unknown>, beforeEntryId?: string): Promise<unknown>;
  requestPrepared(type: 'prompt', prepare: (id: string) => Promise<PreparedLine>, beforeWrite: () => void): Promise<unknown>;
  sendUI(record: Record<string, unknown>): Promise<void>;
  markSynchronized(token?:string): void|Promise<void>; close(): Promise<void>;
  detach?(): Promise<void>; captureBegin?(): Promise<{token: string; from: number}>;
  captureFinish?(token: string): Promise<OwnerBaseline>; captureAck?(token: string): Promise<void>;
  setQueueReservation?(reservation: OwnerQueueReservation): void;
  queueAcknowledged?(id: string): Promise<void>;
  setEpoch?(next: number, sessionFile?: string): Promise<void>;
}
export type TransportFactory = (callbacks: Pick<RpcClientOptions, 'onEvent' | 'onExit' | 'onProtocolError' | 'measure'>) => PrimaryTransport;
export type TransportFailure = RpcError;
