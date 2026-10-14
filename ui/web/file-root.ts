import type {FileRootSelection} from '../shared/files.ts';
export type RootIO = {get(workspace:string):Promise<FileRootSelection>;put(workspace:string,path:string,revision:number):Promise<FileRootSelection>};
/** One browse preference belongs to a workspace, never to a focused conversation. */
export class FileRootChoice {
  workspace?:string;
  selection?:FileRootSelection;
  loading = false;
  error?:string;
  private generation = 0;
  private io:RootIO;private changed:()=>void;
  constructor(io:RootIO,changed:()=>void) {this.io = io;this.changed = changed;}
  observe(workspace:string,path?:string):void {
    if (workspace === this.workspace) return;
    this.workspace = workspace;this.selection = undefined;this.error = undefined;
    const generation = ++this.generation;this.loading = true;this.changed();
    void this.run(workspace,generation,async()=> {
      const selection = await this.io.get(workspace);
      if (!this.current(workspace,generation)) return selection;
      if (!selection.root && path) return this.io.put(workspace,path,selection.revision);
      return selection;
    });
  }
  private current(workspace:string,generation:number):boolean {return workspace === this.workspace && generation === this.generation;}
  private async run(workspace:string,generation:number,read:()=>Promise<FileRootSelection>):Promise<void> {
    try {const selection = await read();if (this.current(workspace,generation)) this.selection = selection;}
    catch (error) {if (this.current(workspace,generation)) this.error = error instanceof Error ? error.message : 'The working folder is unavailable.';}
    finally {if (this.current(workspace,generation)) {this.loading = false;this.changed();}}
  }
  async choose(path:string):Promise<void> {
    const workspace = this.workspace;if (!workspace) return;
    const generation = ++this.generation;this.loading = true;this.error = undefined;this.changed();
    await this.run(workspace,generation,async()=> {
      const selection = await this.io.get(workspace);
      if (!this.current(workspace,generation)) return selection;
      return this.io.put(workspace,path,selection.revision);
    });
    if (this.current(workspace,generation) && this.error) throw new Error(this.error);
  }
}
