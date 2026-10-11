import { describe, expect, it } from 'vitest';
import { phoenixAiClosedAccounting } from '../../server/ai-trader/phoenix-accounting';
import { reducePhoenixHistory } from '../../server/protocol/phoenix/accounting-reducer';
import { event, snapshot, origin, target } from '../helpers/phoenix-accounting';
import { aiBot, aiAuthority, clamped, filled, now } from '../helpers/phoenix-ai';
import { buildPhoenixAiEntry } from '../../server/ai-trader/phoenix-sizing';
function fixture() {
 const i = buildPhoenixAiEntry(aiBot(), 'EXAMPLE-decision', clamped(), aiAuthority(), '1', now), entry = filled(i);
 const close = { ...filled(i), intent: { ...i, action: 'close' as const, side: 'sell' as const, sequence: '2', protection: undefined },
  state: 'settled' as const, data: { ...entry.data, orderId: 'EXAMPLE-close-order', fills: [{ ...entry.data.fills![0], orderId: 'EXAMPLE-close-order', fillId: 'EXAMPLE-close-fill' }], remainingPositionLots: '0' } };
 const events = [event(1,'0','66',{market:i.market,orderId:entry.data.orderId!,fillId:entry.data.fills![0].fillId,feeMicros:'35000'}),
  event(2,'66','0',{market:i.market,orderId:close.data.orderId,fillId:'EXAMPLE-close-fill',feeMicros:'35000',grossPnlMicros:'5000000'})];
 const snap = snapshot(), state = { revision: 1, status: 'complete' as const, origin, events, snapshot: snap,
  epochs: reducePhoenixHistory(target,events,snap,now) };
 return { state, entry, close };
}
describe('U14 actual epoch PnL', () => {
 it('attributes complete shared history net of both fees to the matching entry and exit', () => {
  const f=fixture(); expect(phoenixAiClosedAccounting(f.state,f.entry,f.close,now)).toMatchObject({realizedPnl:4.93,feesPaid:0.07});
 });
 it.each(['unknown','missing_fill','changed_epoch','stale','wrong_bot','wrong_market'])('leaves %s accounting unknown', defect => {
  const f=fixture();
  if(defect==='unknown')f.state.status='unknown' as any;
  if(defect==='missing_fill')f.close.data.fills[0].fillId='EXAMPLE-other';
  if(defect==='changed_epoch')f.state.epochs[0].netPnlMicros='999999999';
  if(defect==='stale')f.state.snapshot.observedAt=now-5000;
  if(defect==='wrong_bot')f.close.intent.botId='EXAMPLE-other';
  if(defect==='wrong_market')f.close.intent.market='BTC-PERP';
  expect(()=>phoenixAiClosedAccounting(f.state,f.entry,f.close,now)).toThrow();
 });
});
