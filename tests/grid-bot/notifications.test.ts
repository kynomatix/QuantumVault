import {afterEach,describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({query:vi.fn(async()=>({rows:[]})),ready:vi.fn(async()=>{}),send:vi.fn(async()=> 'sent' as const),start:vi.fn()}));
vi.mock('../../server/db',()=>({pool:{query:mocks.query}}));
vi.mock('../../server/schema-readiness',()=>({requireSchemaCapabilityReady:mocks.ready}));
vi.mock('../../server/notification-service',()=>({sendGridOwnerNotification:mocks.send}));
vi.mock('../../server/grid-bot/monitor',()=>({GridMonitor:class {start=mocks.start;}}));
import {gridNotificationText,stopGridNotifications} from '../../server/grid-bot/notifications';
import {startGridBotMonitor,stopGridBotMonitor} from '../../server/grid-bot/monitor-runtime';
describe('Grid notification channel and independent startup',()=>{
  afterEach(async()=>{await stopGridNotifications();vi.clearAllMocks();});
  it('starts only the notification reader while the hard money worker gate is off',async()=>{await startGridBotMonitor();await stopGridBotMonitor();expect(mocks.ready).toHaveBeenCalledWith('grid_bot',expect.any(Function));expect(mocks.query).toHaveBeenCalledOnce();expect(mocks.start).not.toHaveBeenCalled();expect(mocks.send).not.toHaveBeenCalled();});
  it.each(['stop','band','pause','resume','resync','paused','range_exhausted','canary','stopped','sol_warning','sol_entry_blocked','sol_unknown'])('renders %s without including private evidence',kind=>{
    const text=gridNotificationText({bot_id:'EXAMPLE_BOT',event_key:'EXAMPLE_EVENT',kind,evidence:{privateKey:'REDACTED',signature:'REDACTED'},wallet_address:'EXAMPLE_OWNER',market:'BTC-PERP'});
    expect(text.title).toContain('BTC-PERP');expect(text.body).toContain('PnL excludes funding');expect(text.body).not.toContain('REDACTED');expect(text.body).not.toContain('Lifecycle event requires attention');
    if(kind==='stop')expect(text.body).toContain('not yet confirmed');if(kind==='stopped')expect(text.body).toContain('terminal settlement confirmed');
  });
});
