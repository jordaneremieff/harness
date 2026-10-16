export const RELEASE_FORMAT = 'ui.release/1';
export const BROWSER_API = 'ui.browser/1';
export type ReleaseManifest = {
  format: typeof RELEASE_FORMAT; id: string; sourceCommit: string; sourceTree: string;
  iteration: string; stagedAt: string; committedAt: string; branch: string;
  lockDigest: string; runtimeDigest: string; assetDigest: string; ownerProtocol: string;
  browserApi: typeof BROWSER_API; generation: string; moduleFamily: string;
  files: Record<string, string>; imports: Record<string, string[]>;
};
export type ReleaseSelection = {current: string; lastGood?: string; updatedAt: string};
export type ReleaseStatus = {current?: string; lastGood?: string; candidate?: string; state: 'ready'|'switching'|'backend-unavailable'; ownerPid: number; backendPid?: number; ownerIncarnation: string; ownerProtocol: string; primaries: {key: string; epoch: number; pid?: number}[]; failed: string[]};
export type ReleaseControl = {kind: 'status'}|{kind: 'switch'; release: string}|{kind: 'rollback'}|{kind: 'stop'};
