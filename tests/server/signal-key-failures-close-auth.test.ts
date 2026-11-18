import { afterEach,expect,it,vi } from 'vitest';
import { readFileSync,existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { insertBotTradeSchema } from '../../shared/schema';
import { closeAuthFixture } from '../helpers/pacifica-close-auth-fetch';
import { readCloseSnapshot,closeResultFromObservation,isConfirmedClose } from '../../server/protocol/close-outcome';
import { submitDurableClose } from '../../server/trading/signal-bot-close-intent';
import { CLOSE_SAVE_FAILED,CLOSE_NOT_SENT } from '../../server/trading/signal-bot-close-intent-types';
import { closeIntentStore } from '../../server/trading/close-intent-store';
vi.mock('../../server/storage',()=>({storage:{getWalletByAgentPublicKey:async()=>undefined,getBotByAgentPublicKey:async()=>undefined}}));
vi.mock('../../server/trading/close-intent-store',async()=>{
  const {makeCloseRouteStore}=await import('../helpers/close-route-intent-store');
  return {closeIntentStore:makeCloseRouteStore({createBotTrade:async()=>({id:'EXAMPLE_TRADE'})})};
});
const classifierPath='../../server/trading/signal-key-failures';
const classifier=existsSync('server/trading/signal-key-failures.ts')?await import(classifierPath):{};
const ast=ts.createSourceFile('routes.ts',readFileSync('server/routes.ts','utf8'),ts.ScriptTarget.Latest,true);
const executor=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='closePerpPosition')!;
const js=ts.transpileModule(executor.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it.each([401,403])('r4.real.closePerpPosition.durable.sender.auth.%s',async httpStatus=>{
  const {adapter,signer,account,posts}=await closeAuthFixture(httpStatus);(closeIntentStore as any).reset();
  const bot={id:'EXAMPLE_BOT',walletAddress:'EXAMPLE_OWNER',market:'BTC-PERP',activeProtocol:'pacifica',protocolSubaccountId:account};
  const storage={getTradingBotById:async()=>bot,getBotPosition:async()=>({baseSize:'1',lastTradeId:'EXAMPLE_ENTRY'})};
  const deps={...classifier,insertBotTradeSchema,crypto:{randomUUID},submitDurableClose,CLOSE_SAVE_FAILED,CLOSE_NOT_SENT,
    storage,readCloseSnapshot,closeResultFromObservation,isConfirmedClose,fullClosesInFlight:new Set(),
    getDefaultAdapter:()=>adapter,_resolveSigningContext:async()=>({publicKey:account,secretKey:signer.secretKey,cleanup:()=>{}})};
  const close=new Function(...Object.keys(deps),js+'return closePerpPosition;')(...Object.values(deps));
  try {
    const result=await close(new Uint8Array(),bot.market,0,1,50,undefined,account,'long',
      {botId:bot.id,walletAddress:bot.walletAddress},bot.walletAddress,adapter,true,undefined,bot.id,false,undefined,'EXAMPLE_CLOSE_SOURCE');
    expect(posts).toHaveLength(1);expect(posts[0].reduce_only).toBe(true);
    expect(result).toMatchObject({success:false,venue:'pacifica',httpStatus,keyFailureKind:'venue_auth_rejected',signingKeyUsed:false});
  } finally {await adapter.shutdown();}
});
