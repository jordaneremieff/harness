import {stat} from 'node:fs/promises';
import type {SavedSession, SavedSessionPage, SavedSessionRead} from '../shared/api.ts';
import {ApiError} from './errors.mts';
import {FileHistory} from './history.mts';
import {savedSessionRevision, validateSessionProject} from './sessions.mts';
import {scanSessionTitle} from './sessions-title.mts';

function readQuery(url:URL){
  const allowed=new Set(['workspace','project','path','id','leaf','before']);
  for(const key of url.searchParams.keys())if(!allowed.has(key)||url.searchParams.getAll(key).length!==1)throw new ApiError('invalid_request','The saved-history query is invalid.');
  const id=url.searchParams.get('id')??'';
  if(!id||id.length>512)throw new ApiError('invalid_request','The saved session identity is invalid.');
  return {id,path:url.searchParams.get('path')??'',project:url.searchParams.get('project')??'',before:boundary(url.searchParams.get('before')),leaf:boundary(url.searchParams.get('leaf'))};
}
function boundary(value:string|null):string|undefined {
  if(value===null)return;
  if(!/^[^\x00-\x1f\x7f]{1,256}$/.test(value))throw new ApiError('invalid_request','The saved-history boundary is invalid.');
  return value;
}
/** Saved ordinary history is an explicit file snapshot, never an attached writer or live branch. */
export class SessionRead {
  private history?:FileHistory;
  async read(url:URL,writers:(page:SavedSessionPage)=>Promise<SavedSessionPage>):Promise<SavedSessionRead>{
    const {id,path,project,before,leaf:requestedLeaf}=readQuery(url);
    if(await validateSessionProject(project,path)!==id)throw new ApiError('invalid_session','The saved session identity changed.',409);
    this.history??=new FileHistory();
    const observedAt=new Date().toISOString(),index=await this.history.index(path),leaf=requestedLeaf??index.lastId;
    const page=await this.history.page(path,leaf,before);
    if(await validateSessionProject(project,path)!==id)throw new ApiError('invalid_session','The saved session identity changed during the read.',409);
    const info=await stat(path),title=await scanSessionTitle(path,info.size);
    const session:SavedSession={id,path,project,revision:savedSessionRevision(path,info),modifiedAt:info.mtime.toISOString(),size:info.size,...title};
    const marked=await writers({items:[session],total:1,omitted:0,nextCursor:null,titleCursor:null,observedAt});
    return {session:marked.items[0]??session,entries:page.entries,coverage:page.coverage,leaf,before:page.coverage.omitted>0?page.entries[0]?.id??null:null,observedAt};
  }
  async close():Promise<void>{await this.history?.close();}
}
