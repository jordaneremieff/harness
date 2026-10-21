import {button, copy, element, setText} from './dom.ts';
import {cardAction} from './card-icons.ts';
import {previewText} from './format.ts';

/** The failure disclosure owns its diagnostic copy and the failed message's existing actions. */
export class ResponseFailure {
  readonly node=element('div','response-failure');
  readonly actions=element('div','response-failure-actions');
  private preview=element('span','response-failure-preview');
  private toggle:HTMLButtonElement;
  private body=element('div','response-failure-body');
  private diagnostic=element('pre','raw');
  private value='';
  constructor(active:()=>boolean,changed:()=>void) {
    this.toggle=button('Details',()=>{if(!active())return;changed();this.body.hidden=!this.body.hidden;this.toggle.setAttribute('aria-expanded',String(!this.body.hidden));},'response-failure-toggle');
    this.toggle.setAttribute('aria-expanded','false');this.body.hidden=true;
    const copyDetails=cardAction('copy','Copy error details',()=>{if(active() && this.value)void copy(this.value,copyDetails);});
    this.actions.append(copyDetails);this.body.append(this.diagnostic,this.actions);
    this.node.append(element('span','response-failure-label','Response failed'),this.preview,this.toggle,this.body);
  }
  update(value:string):void {
    this.value=value;
    setText(this.preview,value.split(/\r?\n/).find(line=>line.trim()) ?? '');this.preview.title=this.preview.textContent ?? '';
    const shown=previewText(value,Number.MAX_SAFE_INTEGER,65536);setText(this.diagnostic,shown.text+(shown.truncated?'\nDetails shortened.':''));
  }
}
