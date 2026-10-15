import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
const mocks=vi.hoisted(()=>({wallet:vi.fn(),decrypt:vi.fn()}));
vi.mock('../../server/storage',()=>({storage:{getWallet:mocks.wallet}}));
vi.mock('../../server/session-v3',()=>({decryptAgentKeyV3:mocks.decrypt}));
import {unlockGridLaunchAgent} from '../../server/grid-bot/launch-authority';
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('SERVER_EXECUTION_KEY',Buffer.alloc(32,7).toString('hex'));});
afterEach(()=>vi.unstubAllEnvs());
function fixture(){
  const pair=nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)),agentKey=Buffer.from(pair.secretKey);pair.secretKey.fill(0);
  const row={address:'EXAMPLE_OWNER',executionEnabled:true,emergencyStopTriggered:false,umkVersion:1,umkEncryptedForExecution:'EXAMPLE_WRAPPED_UMK',
    agentPublicKey:bs58.encode(pair.publicKey),agentPrivateKeyEncryptedV3:'EXAMPLE_V3_CIPHERTEXT'};
  mocks.wallet.mockResolvedValue(row);mocks.decrypt.mockReturnValue(agentKey);
  return {row,agentKey};
}
describe('C5 durable agent generation',()=>{
  it('uses the exact V3 key and explicitly wipes it after successful reads',async()=>{
    const f=fixture(),umk=Buffer.alloc(32,7),result=await unlockGridLaunchAgent(f.row.address,umk);
    expect(result).not.toBeNull();expect(result!.masterAccount).toBe(f.row.agentPublicKey);expect(result!.umkVersion).toBe(1);
    expect(mocks.decrypt).toHaveBeenCalledWith(umk,f.row.agentPrivateKeyEncryptedV3,f.row.address);expect(await result!.current()).toBe(true);
    result!.cleanup();expect(f.agentKey.every(v=>v===0)).toBe(true);expect(umk.every(v=>v===7)).toBe(true);umk.fill(0);
  });
  it.each(['missing wallet','wrong wallet','disabled','emergency','missing wrap','missing V3','missing public key','missing generation','missing server key','invalid server key'])('denies %s without decrypting',async defect=>{
    const f=fixture();
    if(defect==='missing wallet')mocks.wallet.mockResolvedValue(null);
    if(defect==='wrong wallet')f.row.address='EXAMPLE_OTHER';
    if(defect==='disabled')f.row.executionEnabled=false;
    if(defect==='emergency')f.row.emergencyStopTriggered=true;
    if(defect==='missing wrap')f.row.umkEncryptedForExecution='';
    if(defect==='missing V3')f.row.agentPrivateKeyEncryptedV3='';
    if(defect==='missing public key')f.row.agentPublicKey='';
    if(defect==='missing generation')f.row.umkVersion=0;
    if(defect==='missing server key')vi.stubEnv('SERVER_EXECUTION_KEY','');
    if(defect==='invalid server key')vi.stubEnv('SERVER_EXECUTION_KEY','EXAMPLE');
    try{expect(await unlockGridLaunchAgent('EXAMPLE_OWNER',Buffer.alloc(32,7))).toBeNull();expect(mocks.decrypt).not.toHaveBeenCalled();}
    finally{f.agentKey.fill(0);}
  });
  it.each(['wrong public key','corrupt public half','short key','decrypt failure'])('wipes any returned key on %s',async defect=>{
    const f=fixture();let returned=f.agentKey;
    if(defect==='wrong public key')f.row.agentPublicKey='EXAMPLE_OTHER';
    if(defect==='corrupt public half')returned[63]^=1;
    if(defect==='short key'){f.agentKey.fill(0);returned=Buffer.alloc(32,7);mocks.decrypt.mockReturnValue(returned);}
    if(defect==='decrypt failure')mocks.decrypt.mockImplementation(()=>{throw Error('EXAMPLE decrypt failed');});
    expect(await unlockGridLaunchAgent('EXAMPLE_OWNER',Buffer.alloc(32,7))).toBeNull();
    if(defect!=='decrypt failure')expect(returned.every(v=>v===0)).toBe(true);else f.agentKey.fill(0);
  });
  it.each(['generation','public key','ciphertext','wrapped UMK','disabled','emergency','deleted'])('rechecks current authority after reads: %s',async defect=>{
    const f=fixture(),result=await unlockGridLaunchAgent('EXAMPLE_OWNER',Buffer.alloc(32,7));expect(result).not.toBeNull();
    const changed={...f.row};
    if(defect==='generation')changed.umkVersion++;
    if(defect==='public key')changed.agentPublicKey='EXAMPLE_OTHER';
    if(defect==='ciphertext')changed.agentPrivateKeyEncryptedV3='EXAMPLE_CHANGED';
    if(defect==='wrapped UMK')changed.umkEncryptedForExecution='EXAMPLE_CHANGED';
    if(defect==='disabled')changed.executionEnabled=false;
    if(defect==='emergency')changed.emergencyStopTriggered=true;
    mocks.wallet.mockResolvedValue(defect==='deleted'?null:changed);
    expect(await result!.current()).toBe(false);result!.cleanup();expect(f.agentKey.every(v=>v===0)).toBe(true);
  });
});
