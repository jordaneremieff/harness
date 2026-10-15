import {isDeepStrictEqual} from 'node:util';
import {workspaceTabKey,type Workspace,type WorkspaceTab,type ConversationLayout,type PaneNode,type Target} from '../shared/api.ts';
import type {ControlIntent,ControlRequest} from '../shared/control.ts';
import {validateConversationLayout} from './state.mts';
import {ApiError} from './errors.mts';
type Leaf=Extract<PaneNode,{kind:'pane'}>;
type Split=Extract<PaneNode,{kind:'split'}>;
export function controlLayout(workspace:Workspace):ConversationLayout {
  if(workspace.conversationLayout)return selectedLayout(workspace,workspace.conversationLayout);
  const tabs:WorkspaceTab[]=workspace.primaryKey?[{kind:'primary'}]:[];
  if(workspace.selectedTarget?.kind==='agent')tabs.push({kind:'agent',identity:workspace.selectedTarget.identity});
  const active=tabs.at(-1);return {root:{kind:'pane',id:'pane-1',tabs,active:active?workspaceTabKey(active):null},focusedPane:'pane-1'};
}
function selectedLayout(workspace:Workspace,stored:ConversationLayout):ConversationLayout {
  const target=workspace.selectedTarget;if(!target||target.kind==='primary'&&!workspace.primaryKey)return stored;
  const focused=leaves(stored).find(leaf=>leaf.id===stored.focusedPane),front=focused?.tabs.find(tab=>workspaceTabKey(tab)===focused.active);if(front?.kind==='file')return stored;
  const tab:WorkspaceTab=target.kind==='agent'?{kind:'agent',identity:target.identity}:{kind:'primary'},key=workspaceTabKey(tab),layout=structuredClone(stored);
  const pane=leaves(layout).find(leaf=>leaf.tabs.some(tab=>workspaceTabKey(tab)===key))??leaves(layout).find(leaf=>leaf.id===layout.focusedPane);if(!pane)return stored;
  if(!pane.tabs.some(tab=>workspaceTabKey(tab)===key))pane.tabs.push(tab);pane.active=key;layout.focusedPane=pane.id;return layout;
}
function nodes(root:PaneNode):PaneNode[] {return root.kind==='pane'?[root]:[root,...nodes(root.first),...nodes(root.second)];}
function leaves(layout:ConversationLayout):Leaf[] {return nodes(layout.root).filter(node=>node.kind==='pane');}
function fail():never {throw new ApiError('invalid_request','The selection does not match the presentation intent.');}
export function controlView(request:ControlRequest):WorkspaceTab|undefined {const intent=request.intent;return intent.action==='show'?{kind:'file',rootId:intent.rootId,path:intent.path,...(intent.preview?{view:'preview' as const}:{})}:intent.action==='split'||intent.action==='focus'?intent.view:undefined;}
function preserveTabs(before:ConversationLayout,after:ConversationLayout,view:WorkspaceTab|undefined):void {
  const oldKeys=leaves(before).flatMap(node=>node.tabs).map(workspaceTabKey),keys=leaves(after).flatMap(node=>node.tabs).map(workspaceTabKey),allowed=view?workspaceTabKey(view):undefined;
  if(oldKeys.some(key=>!keys.includes(key))||keys.some(key=>!oldKeys.includes(key)&&key!==allowed))fail();
}
function branchChange(before:ConversationLayout,after:ConversationLayout,intent:Extract<ControlIntent,{action:'resize'|'swap'}>):void {
  const expected=structuredClone(before),target=nodes(expected.root).find(node=>node.id===intent.splitId);if(target?.kind!=='split')fail();
  if(intent.action==='resize')target.ratio=intent.ratio;else [target.first,target.second]=[target.second,target.first];
  if(!isDeepStrictEqual(expected,after))fail();
}
function sourceActive(source:Leaf,remaining:WorkspaceTab[],key:string):string|null {
  if(source.active!==key)return source.active;
  const index=source.tabs.findIndex(tab=>workspaceTabKey(tab)===key),adjacent=remaining[Math.min(Math.max(0,index),remaining.length-1)];return adjacent?workspaceTabKey(adjacent):null;
}
function splitNodes(before:ConversationLayout,after:ConversationLayout,intent:Extract<ControlIntent,{action:'split'}>):{source:Leaf;current:Leaf;added:Leaf;parent:Split} {
  const oldLeaves=leaves(before),newLeaves=leaves(after),source=oldLeaves.find(node=>node.id===intent.paneId);
  if(!source||newLeaves.length!==oldLeaves.length+1||nodes(after.root).length!==nodes(before.root).length+2)fail();
  const additions=newLeaves.filter(node=>!oldLeaves.some(old=>old.id===node.id)),added=additions[0];if(additions.length!==1||!added)fail();
  const current=newLeaves.find(leaf=>leaf.id===source.id),parent=nodes(after.root).find(node=>node.kind==='split'&&node.first.id===source.id&&node.second.id===added.id);
  if(!current||parent?.kind!=='split'||parent.axis!==intent.axis||parent.ratio!==50)fail();return {source,current,added,parent};
}
function replacePane(node:PaneNode,id:string,replacement:PaneNode):PaneNode {if(node.id===id)return replacement;if(node.kind==='pane')return node;return {...node,first:replacePane(node.first,id,replacement),second:replacePane(node.second,id,replacement)};}
function splitChange(before:ConversationLayout,after:ConversationLayout,intent:Extract<ControlIntent,{action:'split'}>):void {
  const {source,current,added,parent}=splitNodes(before,after,intent),key=workspaceTabKey(intent.view);
  if(added.tabs.length!==1||workspaceTabKey(added.tabs[0] as WorkspaceTab)!==key||added.active!==key||after.focusedPane!==added.id)fail();
  const remaining=source.tabs.filter(tab=>workspaceTabKey(tab)!==key);if(!remaining.length||!isDeepStrictEqual(current.tabs,remaining)||current.active!==sourceActive(source,remaining,key))fail();
  const expected=structuredClone(before);expected.root=replacePane(expected.root,source.id,{...parent,first:current,second:added});expected.focusedPane=added.id;
  if(!isDeepStrictEqual(expected,after))fail();
}
function revealChange(before:ConversationLayout,after:ConversationLayout,intent:Extract<ControlIntent,{action:'show'|'focus'}>,view:WorkspaceTab|undefined):void {
  const key=view?workspaceTabKey(view):undefined,owner=leaves(before).find(node=>view&&node.tabs.some(tab=>workspaceTabKey(tab)===key));
  const destination=intent.action==='show'?intent.paneId??owner?.id??before.focusedPane:intent.paneId;
  if(owner&&owner.id!==destination)fail();
  const expected=structuredClone(before),leaf=leaves(expected).find(node=>node.id===destination);if(!leaf)fail();
  if(view){if(!leaf.tabs.some(tab=>workspaceTabKey(tab)===key))leaf.tabs.push(view);leaf.active=key as string;}
  expected.focusedPane=destination;if(!isDeepStrictEqual(expected,after))fail();
}
function selectionTarget(workspace:Workspace,request:ControlRequest,after:ConversationLayout,body:Record<string,unknown>):void {
  const focused=leaves(after).find(leaf=>leaf.id===after.focusedPane),active=focused?.tabs.find(tab=>workspaceTabKey(tab)===focused.active);
  if(body.selectedTarget!==undefined) {
    let expected:Target|null=workspace.selectedTarget??null;
    if(active?.kind==='agent')expected={kind:'agent',identity:active.identity};
    else if(active?.kind==='primary')expected=request.primary??null;
    else if(!active)expected=null;
    if(!isDeepStrictEqual(body.selectedTarget,expected))fail();
  }
  if(body.panelVisible!==undefined&&body.panelVisible!==(active?.kind==='agent'))fail();
}
/** A control selection preserves every existing view and changes only its requested arrangement. */
export function validateControlChange(workspace:Workspace,request:ControlRequest,body:Record<string,unknown>):void {
  if(Object.keys(body).some(key=>!['expectedRevision','conversationLayout','selectedTarget','panelVisible','filePositions'].includes(key)))fail();
  const before=controlLayout(workspace),after=body.conversationLayout;validateConversationLayout(after);const intent=request.intent,view=controlView(request);preserveTabs(before,after,view);
  if(intent.action==='notice')fail();
  if(intent.action==='resize'||intent.action==='swap')branchChange(before,after,intent);
  else if(intent.action==='split')splitChange(before,after,intent);
  else revealChange(before,after,intent,view);
  selectionTarget(workspace,request,after,body);
}
