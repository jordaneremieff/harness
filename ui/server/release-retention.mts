import {opendir, unlink} from 'node:fs/promises';
import {basename, join, resolve, isAbsolute} from 'node:path';
import {releaseRoot, readSelection, boundedFile, findRelease, releaseId, RELEASE_LIMITS} from './release-store.mts';
import {requestReleaseControl} from './release-control.mts';

type RetainedRelease = {id:string; stagedAt:string};
/** Free only the oldest unprotected descriptor slots needed for one new release. */
export function retirementPlan(records:readonly RetainedRelease[], protectedIds:ReadonlySet<string>):string[] {
  const count=Math.max(0,records.length-RELEASE_LIMITS.releases+1);
  const candidates=records.filter(record=>!protectedIds.has(record.id)).sort((a,b)=>a.stagedAt.localeCompare(b.stagedAt)||a.id.localeCompare(b.id));
  if(candidates.length<count)throw new Error('Release capacity is protected; no safe descriptor slot is available.');
  return candidates.slice(0,count).map(record=>record.id);
}
async function retainedReleases(root:string):Promise<RetainedRelease[]> {
  const records:RetainedRelease[]=[];
  const directory=await opendir(join(root,'releases'),{bufferSize:1});
  for await(const entry of directory) {
    if(records.length>=RELEASE_LIMITS.releases||!entry.isFile()||!entry.name.endsWith('.json')||!releaseId(entry.name.slice(0,-5)))throw new Error('Release descriptor integrity prevents retention.');
    const id=entry.name.slice(0,-5),{manifest}=await findRelease(root,id);
    records.push({id,stagedAt:manifest.stagedAt});
  }
  return records;
}
/** Retire catalog descriptors only; sealed source and dependencies remain available to loaded code and explicit bindings. */
export async function pruneReleases(stateDir:string, keep:readonly string[]=[]) {
  if(keep.length>RELEASE_LIMITS.releases||keep.some(id=>!releaseId(id)))throw new Error('Use complete protected release identities.');
  const paths=await releaseRoot(stateDir);
  const status=await requestReleaseControl(paths.control,{kind:'status'}) as {state?:string;current?:string;lastGood?:string;failed?:string[];ownerPid?:number};
  if(status.state!=='ready')throw new Error('Release retention requires a ready owner.');
  const selection=await readSelection(paths.root);
  if(!selection||selection.current!==status.current||selection.lastGood!==status.lastGood)throw new Error('Release selection changed; retention refused.');
  const owner=JSON.parse((await boundedFile(paths.claim,4096)).toString('utf8')) as {pid?:number;release?:string};
  if(owner.pid!==status.ownerPid||typeof owner.release!=='string'||!isAbsolute(owner.release))throw new Error('The owner release identity is unavailable.');
  const ownerRelease=basename(resolve(owner.release));
  if(!releaseId(ownerRelease))throw new Error('The owner release identity is invalid.');
  const protectedIds=new Set([selection.current,selection.lastGood,ownerRelease,...(status.failed??[]),...keep].filter((id):id is string=>id!==undefined));
  if([...protectedIds].some(id=>!releaseId(id)))throw new Error('A protected release identity is invalid.');
  const records=await retainedReleases(paths.root);
  const removed=retirementPlan(records,protectedIds);
  for(const id of removed) {
    const current=await readSelection(paths.root);
    const currentOwner=JSON.parse((await boundedFile(paths.claim,4096)).toString('utf8')) as {pid?:number;release?:string};
    if(JSON.stringify(current)!==JSON.stringify(selection)||currentOwner.pid!==owner.pid||currentOwner.release!==owner.release)throw new Error('The release owner or selection changed; retention stopped.');
    await unlink(join(paths.root,'releases',`${id}.json`));
  }
  return {removed,protected:[...protectedIds],remaining:records.length-removed.length,sealedSnapshotsRetained:true};
}
