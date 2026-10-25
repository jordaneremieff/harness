import {isAbsolute,join} from 'node:path';
import {realpath,stat} from 'node:fs/promises';
import {DefaultPackageManager,ModelRuntime,ProjectTrustStore,SettingsManager} from '@earendil-works/pi-coding-agent';
import {RuntimeError} from './contract.mts';

export class PiManagement {
  private modelsPromise?:Promise<ModelRuntime>;
  readonly agentDir:string;
  constructor(agentDir:string) {this.agentDir=agentDir;}
  models():Promise<ModelRuntime> {
    this.modelsPromise??=ModelRuntime.create({authPath:join(this.agentDir,'auth.json'),modelsPath:join(this.agentDir,'models.json'),modelsStorePath:join(this.agentDir,'models-store'),allowModelNetwork:false,refreshOnCreate:false});
    return this.modelsPromise.catch(error=>{this.modelsPromise=undefined;throw error;});
  }
  async folder(cwd:string) {
    if(!isAbsolute(cwd))throw new RuntimeError('invalid_request','The working folder must be absolute.');
    const path=await realpath(cwd);if(!(await stat(path)).isDirectory())throw new RuntimeError('invalid_request','The working folder is not a directory.');return path;
  }
  async settings(cwd:string) {
    const folder=await this.folder(cwd),trust=new ProjectTrustStore(this.agentDir);
    const settings=SettingsManager.create(folder,this.agentDir,{projectTrusted:trust.get(folder)===true});
    if(settings.drainErrors().length)throw new RuntimeError('invalid_config','Pi settings are invalid or unavailable.');
    return {cwd:folder,settings,trust};
  }
  async trust(cwd:string,decision?:boolean|null) {
    const folder=await this.folder(cwd),trust=new ProjectTrustStore(this.agentDir);if(decision!==undefined)trust.set(folder,decision);
    return {cwd:folder,decision:trust.get(folder),entry:trust.getEntry(folder),activation:'new-services'};
  }
  async packages(cwd:string) {const current=await this.settings(cwd);return new DefaultPackageManager({cwd:current.cwd,agentDir:this.agentDir,settingsManager:current.settings});}
  async packageAction(request:{operation:string;cwd:string;source?:string;local?:boolean}) {
    const manager=await this.packages(request.cwd);
    if(request.operation==='packages.list')return {items:manager.listConfiguredPackages()};
    if(request.operation==='packages.install')await manager.installAndPersist(request.source as string,{local:request.local});
    else if(request.operation==='packages.remove')await manager.removeAndPersist(request.source as string,{local:request.local});
    else await manager.update(request.source);
    return {applied:true,activation:'new-services',items:manager.listConfiguredPackages()};
  }
  async resources(cwd:string) {
    const current=await this.settings(cwd),manager=await this.packages(current.cwd);
    // Resolution skips absent packages. Inspection never installs or executes extensions.
    const paths=await manager.resolve(async()=> 'skip');
    const limit=256;
    return {cwd:current.cwd,projectTrusted:current.settings.isProjectTrusted(),extensions:paths.extensions.slice(0,limit),skills:paths.skills.slice(0,limit),prompts:paths.prompts.slice(0,limit),themes:paths.themes.slice(0,limit),
      coverage:{limit,complete:paths.extensions.length<=limit&&paths.skills.length<=limit&&paths.prompts.length<=limit&&paths.themes.length<=limit},extensionExecution:false,missingPackages:'skipped',scope:'Resolved resource paths, not executed extension contributions'};
  }
}
