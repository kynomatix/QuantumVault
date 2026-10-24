import {GridProvision as Core,type GridProvisionDeps} from './provision-core';
import {defaultGridLaunchAuthority} from './launch-authority';
import {durableGridUmk} from './service';
export * from './provision-core';
export class GridProvision extends Core {
  constructor(deps:GridProvisionDeps){super(deps,{umk:durableGridUmk,authority:defaultGridLaunchAuthority});}
}
