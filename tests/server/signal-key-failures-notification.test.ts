import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const port=vi.hoisted(()=>({wallet:{} as any,error:null as Error|null}));
vi.mock('../../server/db',()=>({db:{select:()=>({from:()=>({where:()=>({limit:async()=>{if(port.error)throw port.error;return port.wallet?[port.wallet]:[];}})})})}}));
import {sendTradeNotification,formatNotificationMessage} from '../../server/notification-service';
const message={type:'bot_paused' as const,botName:'<b>EXAMPLE & bot</b>',market:'BTC-PERP',error:'EXAMPLE_KEY'};
beforeEach(()=>{port.error=null;port.wallet={notificationsEnabled:true,notifyTradeFailed:true,telegramChatId:'EXAMPLE_CHAT'};vi.stubEnv('TELEGRAM_BOT_TOKEN','EXAMPLE');vi.stubGlobal('fetch',vi.fn(async()=>({ok:true})));});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('SB01 notification',()=>{
 it('escapes.bot.name',()=>{const result=formatNotificationMessage(message);expect(result.body).toContain('&lt;b&gt;EXAMPLE &amp; bot&lt;/b&gt;');expect(result.body).not.toContain('<b>EXAMPLE');});
 it('bot.paused.sends.one.telegram',async()=>{expect(await sendTradeNotification('EXAMPLE_OWNER',message)).toBe(true);expect(fetch).toHaveBeenCalledTimes(1);});
 it.each(['notificationsEnabled','notifyTradeFailed','telegramChatId'])('opt.in.preference.%s',async field=>{port.wallet[field]=false;expect(await sendTradeNotification('EXAMPLE_OWNER',message)).toBe(false);expect(fetch).not.toHaveBeenCalled();});
 it.each(['wallet','notificationsEnabled','notifyTradeFailed','telegramChatId'])('r4.skip.%s.does.not.throw',async field=>{
  if(field==='wallet')port.wallet=null;else port.wallet[field]=false;
  expect(await sendTradeNotification('EXAMPLE_OWNER',message,{throwOnDeliveryError:true})).toBe(false);expect(fetch).not.toHaveBeenCalled();
 });
 it.each(['lookup','transport'])('r4.failed.%s.throws.only.for.disposition.caller',async kind=>{
  if(kind==='lookup')port.error=new Error('EXAMPLE_LOOKUP');else vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('EXAMPLE_TRANSPORT');}));
  expect(await sendTradeNotification('EXAMPLE_OWNER',message)).toBe(false);
  await expect(sendTradeNotification('EXAMPLE_OWNER',message,{throwOnDeliveryError:true})).rejects.toThrow();
 });

 // The brief permits preserving these failures when the shared boolean sender
 // cannot distinguish permanent refusals from transient delivery failures.
 it.each([400,403,429,503])('r5.telegram.http.%s.is.opaque.to.opt.in.caller',async status=>{
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status,json:async()=>({description:'EXAMPLE_REFUSAL'})})));
  expect(await sendTradeNotification('EXAMPLE_OWNER',message)).toBe(false);
  await expect(sendTradeNotification('EXAMPLE_OWNER',message,{throwOnDeliveryError:true})).rejects.toThrow('trade_notification_delivery_failed');
 });
 it('r5.telegram.missing.token.is.opaque.to.opt.in.caller',async()=>{
  vi.stubEnv('TELEGRAM_BOT_TOKEN','');
  expect(await sendTradeNotification('EXAMPLE_OWNER',message)).toBe(false);
  await expect(sendTradeNotification('EXAMPLE_OWNER',message,{throwOnDeliveryError:true})).rejects.toThrow('trade_notification_delivery_failed');
 });

});
