import {workspaceTabKey, type FileTab, type PaneNode, type Workspace} from '../shared/api.ts';
import {movedFilePath as movedPath,type FileMove as DiskMove} from '../shared/files.ts';
export function markdownPath(path:string):boolean {return /\.(md|markdown|mdown)$/i.test(path);}
export type FileMove = {rootId:string}&Pick<DiskMove,'from'|'to'>;
export function movedFilePath(path:string,move:Pick<FileMove,'from'|'to'>):string {return movedPath(path,move.from,move.to);}
export function movedFileTab(tab:FileTab,move:FileMove):FileTab {return tab.rootId === move.rootId ? {...tab,path:movedFilePath(tab.path,move)} : tab;}
export function movedFileKey(key:string,move:FileMove):string {
  const prefix = key.startsWith('file:') ? 'file:' : key.startsWith('preview:') ? 'preview:' : undefined;if (!prefix) return key;
  try {const [rootId,path] = JSON.parse(key.slice(prefix.length)) as [string,string];return typeof path === 'string' && rootId === move.rootId ? workspaceTabKey({kind:'file',rootId,path:movedFilePath(path,move),...(prefix === 'preview:' ? {view:'preview'} : {})}) : key;} catch {return key;}
}
function movedPane(node:PaneNode,move:FileMove):PaneNode {return node.kind === 'split' ? {...node,first:movedPane(node.first,move),second:movedPane(node.second,move)} : {...node,tabs:node.tabs.map(tab=>tab.kind === 'file' ? movedFileTab(tab,move) : tab),active:node.active ? movedFileKey(node.active,move) : null};}
export function movedWorkspaceFiles(workspace:Workspace,move:FileMove):Workspace {
  return {...workspace,...(workspace.conversationLayout ? {conversationLayout:{...workspace.conversationLayout,root:movedPane(workspace.conversationLayout.root,move)}} : {}),...(workspace.filePositions ? {filePositions:Object.fromEntries(Object.entries(workspace.filePositions).map(([key,value])=>[movedFileKey(key,move),value]))} : {})};
}
