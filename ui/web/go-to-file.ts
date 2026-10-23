import type {FileRoot, FileSearchResult, FileSearchRow} from '../shared/files.ts';
import {cardIcon} from './card-icons.ts';
import {button, element, input} from './dom.ts';
import {navigateOptions} from './list-navigation.ts';
import type {Modal} from './modal.ts';
import {ApiError, errorMessage} from './transport.ts';

type Navigation = {
  current():boolean;
  search(query:string,signal:AbortSignal):Promise<FileSearchResult>;
  choose(path:string):void;
};
function searchFacts(result:FileSearchResult):string {
  const facts:string[]=[];
  if(!result.rows.length)facts.push(result.coverage.complete?'No matching files or folders.':'No matches in the searched part of the folder.');
  if(result.more)facts.push('More matches. Refine the name or folder.');
  if(!result.coverage.complete)facts.push(result.coverage.reason||'The search covered only part of the folder.');
  return facts.join(' ');
}
function searchFailure(cause:unknown):string {
  return cause instanceof ApiError&&cause.view.code==='file_cancelled'
    ?'Another file search replaced this search. Refine the name or folder again.'
    :`File search is unavailable. ${errorMessage(cause)}`;
}
/** File navigation owns only this dialog's query and lifetime, never a conversation draft. */
export function goToFile(modal:Modal,root:FileRoot,navigation:Navigation):void {
  let pending:AbortController|undefined,revision=0;
  const body=modal.open('Go to file…',undefined,()=>{revision++;pending?.abort();});
  modal.node.dataset.variant='picker';const token=modal.token;
  const control=input('File name or folder',''),field=control.field as HTMLInputElement;
  field.id='go-to-file-query';control.label.htmlFor=field.id;control.label.className='sr-only';
  field.type='search';field.className='picker-input';field.placeholder='File name or folder';field.autocomplete='off';field.spellcheck=false;field.maxLength=200;
  const list=element('div','file-navigation-list'),status=element('p','secondary file-navigation-status');
  list.id='go-to-file-results';list.setAttribute('aria-label','Matching files and folders');field.setAttribute('aria-controls',list.id);status.setAttribute('role','status');
  body.append(element('p','secondary file-navigation-scope',`Working folder: ${root.path}`),control.label,field,list,status);
  modal.actions(button('Cancel',()=>modal.close()));
  const current=():boolean=> {
    if(!modal.owns(token))return false;
    if(navigation.current())return true;
    pending?.abort();revision++;list.replaceChildren();list.removeAttribute('aria-busy');field.disabled=true;
    status.textContent='The workspace or working folder changed. Close this dialog and choose Go to file again.';return false;
  };
  const choose=(row:FileSearchRow,version:number):void=> {
    if(!current()||version!==revision)return;
    if(row.kind==='directory'){field.value=`${row.path}/`;field.focus();void search();return;}
    modal.close(false);navigation.choose(row.path);
  };
  const row=(item:FileSearchRow,version:number):HTMLElement=> {
    const node=button('',()=>choose(item,version),'file-navigation-row');node.dataset.path=item.path;
    node.setAttribute('aria-label',`${item.kind==='directory'?'Folder':'File'} ${item.path}`);
    const words=element('span','file-navigation-words'),parent=item.path.split('/').slice(0,-1).join('/');
    words.append(element('span','file-navigation-name',`${item.name}${item.kind==='directory'?'/':''}`),element('span','secondary file-navigation-parent',parent||'.'));
    node.append(cardIcon(item.kind==='directory'?'folder':'file'),words);return node;
  };
  const ownsResult=(version:number,abort:AbortController):boolean=>modal.owns(token)&&!abort.signal.aborted&&version===revision&&current();
  const finishSearch=(version:number):void=> {if(modal.owns(token)&&version===revision)list.removeAttribute('aria-busy');};
  const search=async():Promise<void>=> {
    if(!current())return;
    pending?.abort();const abort=new AbortController();pending=abort;const version=++revision,query=field.value;
    list.replaceChildren();list.setAttribute('aria-busy','true');status.textContent='Searching file names…';
    try {
      const result=await navigation.search(query,abort.signal);
      if(!ownsResult(version,abort))return;
      if(result.rootId!==root.id||result.query!==query)throw new Error('The file search response changed. Refine the name or folder again.');
      list.replaceChildren(...result.rows.map(item=>row(item,version)));
      status.textContent=searchFacts(result);
    } catch(cause) {
      if(!ownsResult(version,abort))return;
      list.replaceChildren();status.textContent=searchFailure(cause);
    } finally {finishSearch(version);}
  };
  field.addEventListener('input',()=>{void search();});
  field.addEventListener('keydown',event=> {
    if(event.isComposing||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;
    const first=list.querySelector<HTMLButtonElement>('button');
    if(first&&event.key==='ArrowDown'){event.preventDefault();first.focus();}
    else if(first&&event.key==='Enter'){event.preventDefault();first.click();}
  });
  list.addEventListener('keydown',event=>navigateOptions(event,list));field.focus();void search();
}
