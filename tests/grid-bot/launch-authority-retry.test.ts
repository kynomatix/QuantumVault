import {describe,it,expect,vi} from 'vitest';
vi.mock('../../server/db',()=>({pool:{}}));
import * as reads from '../../server/grid-bot/launch-reads';
import {defaultGridLaunchAuthority,GridLaunchAuthority} from '../../server/grid-bot/launch-authority';
describe('C5 N3 default authority initialization',()=>{
  it('fails closed for a transient construction failure and retries on the next call',async()=>{
    const constructor=vi.spyOn(reads,'GridLaunchReads').mockImplementationOnce(function(){throw Error('EXAMPLE transient initialization');});
    try{await expect(defaultGridLaunchAuthority()).rejects.toThrow('transient');const recovered=await defaultGridLaunchAuthority();
      expect(recovered).toBeInstanceOf(GridLaunchAuthority);expect(await defaultGridLaunchAuthority()).toBe(recovered);expect(constructor).toHaveBeenCalledTimes(2);
    }finally{constructor.mockRestore();}
  });
});
