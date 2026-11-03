import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {recoveryJs} from './recovery.mts';

test('recovery replacement requires a read digest and explicit scope confirmation',async()=>{
  type Element={value:string;textContent:string;onclick?:()=>Promise<void>;onchange?:()=>void};
  const elements=new Map<string,Element>();
  const element=(id:string)=>{let value=elements.get(id);if(!value){value={value:'',textContent:''};elements.set(id,value);}return value;};
  const click=async(id:string)=>{const handler=element(id).onclick;assert.ok(handler);await handler();};
  const requests:Record<string,unknown>[]=[],confirmations:string[]=[];
  let accepted=false;
  element('target').value='runtime';
  runInNewContext(recoveryJs,{
    document:{getElementById:element,querySelectorAll:()=>[]},
    confirm:(message:string)=>{confirmations.push(message);return accepted;},
    fetch:async(_url:string,options:{body:string})=>{
      const request=JSON.parse(options.body).request;requests.push(request);
      return {json:async()=>({ok:true,value:request.operation==='config.inspect'?{digest:'a'.repeat(64),status:'invalid',values:null}:request.operation==='config.repair'?{snapshot:{digest:'b'.repeat(64)}}:{}})};
    },
  });
  await click('repair-config');
  assert.equal(element('result').textContent,'Read the invalid configuration first.');
  assert.equal(requests.filter(request=>request.operation==='config.repair').length,0);
  await click('read-config');
  element('config').value='{"port":4322}';
  await click('repair-config');
  assert.equal(requests.filter(request=>request.operation==='config.repair').length,0);
  assert.match(confirmations[0],/replaces the document; it does not migrate it/);
  assert.ok(confirmations[0].includes(`complete original bytes stay in the private config-backups/runtime-${'a'.repeat(64)}.json backup`));
  assert.match(confirmations[0],/Other original settings are not copied/);
  accepted=true;await click('repair-config');
  const repair=requests.find(request=>request.operation==='config.repair');assert.ok(repair);
  assert.equal(repair.target,'runtime');assert.equal(repair.confirm,true);assert.equal(repair.expectedDigest,'a'.repeat(64));
  assert.equal((repair.values as {port:number}).port,4322);
  const targetChanged=element('target').onchange;assert.ok(targetChanged);targetChanged();await click('repair-config');
  assert.equal(requests.filter(request=>request.operation==='config.repair').length,1);
});
