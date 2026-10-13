import type { CachedRoster, PrimaryView, Snapshot, Target, TargetState, TargetPreparation } from '../shared/api.ts';
import { targetIdentity, visibleTargets } from './state.ts';
import { request } from './transport.ts';
export type SnapshotReader = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
/** History refresh is independent of the baseline needed for input and stream readiness. */
export async function refreshVisible(snapshot: () => Promise<void>, history: () => Promise<void>, failure: (error: unknown) => void): Promise<void> {
  await snapshot();
  void history().catch(failure);
}
/** Missing active draft state stays unavailable until its exact target is read. */
export async function hydrateVisible<T extends Snapshot>(snapshot: T, read: SnapshotReader = request, messageTarget?: Target, passiveTargets: readonly Target[] = []): Promise<T> {
  let primaries = snapshot.primaries;
  const key = snapshot.workspace.primaryKey;
  if (key && !primaries.some(item => item.key === key)) {
    const current = await read<PrimaryView>(`/api/primaries/${encodeURIComponent(key)}`);
    primaries = [...primaries, current];
  }
  const primary = primaries.find(item => item.key === key);
  const visible = visibleTargets(snapshot.workspace, primary ? {kind: 'primary', key: primary.key, epoch: primary.epoch} : undefined);
  if (messageTarget && !visible.some(target => targetIdentity(target) === targetIdentity(messageTarget))) visible.push(messageTarget);
  const passive = new Set(passiveTargets.map(targetIdentity));
  const missing = visible.filter(target => {
    const index = snapshot.targetIndex?.find(index => targetIdentity(index.target) === targetIdentity(target));
    const saved = snapshot.targets?.find(saved => targetIdentity(saved.target) === targetIdentity(target));
    if (!index && passive.has(targetIdentity(target))) return false;
    return !saved || !!index && (saved.draft.revision < index.draftRevision || index.unconfirmedOperationIds.some(id => !saved.unconfirmed.some(item => item.operationId === id)));
  });
  const [targets, roster] = await Promise.all([
    Promise.all(missing.map(async target => {
      const index = snapshot.targetIndex?.find(index => targetIdentity(index.target) === targetIdentity(target));
      const path = `/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/targets`;
      return index ? read<TargetState>(`${path}/${encodeURIComponent(index.targetKey)}`) : (await read<TargetPreparation>(path, 'POST', {target})).targetState;
    })),
    snapshot.omitted?.includes('roster') ? read<CachedRoster>('/api/agents?limit=20') : Promise.resolve(snapshot.roster),
  ]);
  return {...snapshot, primaries, roster, targets: [...(snapshot.targets ?? []).filter(saved => !targets.some(current => current.targetKey === saved.targetKey)), ...targets], dialogs: snapshot.omitted?.includes('dialogs') && primary ? primary.pendingDialogs : snapshot.dialogs};
}
