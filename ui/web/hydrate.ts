import type { CachedRoster, PrimaryView, Snapshot, Target, TargetState } from '../shared/api.ts';
import { targetIdentity } from './state.ts';
import { request } from './transport.ts';
export type SnapshotReader = <T>(path: string) => Promise<T>;
/** History refresh is independent of the baseline needed for input and stream readiness. */
export async function refreshVisible(snapshot: () => Promise<void>, history: () => Promise<void>, failure: (error: unknown) => void): Promise<void> {
  await snapshot();
  void history().catch(failure);
}
/** Missing active draft state stays unavailable until its exact target is read. */
export async function hydrateVisible<T extends Snapshot>(snapshot: T, read: SnapshotReader = request, messageTarget?: Target): Promise<T> {
  let primaries = snapshot.primaries;
  const key = snapshot.workspace.primaryKey;
  if (key && !primaries.some(item => item.key === key)) {
    const current = await read<PrimaryView>(`/api/primaries/${encodeURIComponent(key)}`);
    primaries = [...primaries, current];
  }
  const primary = primaries.find(item => item.key === key);
  const visible: Target[] = primary ? [{kind: 'primary', key: primary.key, epoch: primary.epoch}] : [];
  if (snapshot.workspace.selectedTarget?.kind === 'agent') visible.push(snapshot.workspace.selectedTarget);
  if (messageTarget) visible.push(messageTarget);
  const missing = (snapshot.targetIndex ?? []).filter(index => {
    if (!visible.some(target => targetIdentity(target) === targetIdentity(index.target))) return false;
    const saved = snapshot.targets?.find(saved => saved.targetKey === index.targetKey);
    return !saved || saved.draft.revision < index.draftRevision || index.unconfirmedOperationIds.some(id => !saved.unconfirmed.some(item => item.operationId === id));
  });
  const [targets, roster] = await Promise.all([
    Promise.all(missing.map(index => read<TargetState>(`/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/targets/${encodeURIComponent(index.targetKey)}`))),
    snapshot.omitted?.includes('roster') ? read<CachedRoster>('/api/agents?limit=20') : Promise.resolve(snapshot.roster),
  ]);
  return {...snapshot, primaries, roster, targets: [...(snapshot.targets ?? []).filter(saved => !targets.some(current => current.targetKey === saved.targetKey)), ...targets], dialogs: snapshot.omitted?.includes('dialogs') && primary ? primary.pendingDialogs : snapshot.dialogs};
}
