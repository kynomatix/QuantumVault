import {incidentCopy,outcomeCopy} from '../../client/src/lib/grid-worker-copy';
import {cardStates,type WorkerIncident,type WorkerPresentation,type WorkerStatus} from '../../client/src/lib/grid-worker-view';
export const fixtureId=(n:number)=>String(n).padStart(8,'0')+'-0000-4000-8000-'+String(n).padStart(12,'0');
export function status(patch:Partial<WorkerStatus>={}):WorkerStatus{return {cardState:'running',executionMode:'external',entriesPaused:false,pauseRevision:'3',pauseAckRevision:null,
  host:{legacy_controls_enabled:false,observer_fenced:false},executionRestrictions:[],stopsAllowed:true,resetBlockedBy:[],incidents:[],incidentCounts:{critical:0,warning:0},
  unacknowledgedCritical:0,acknowledgedCritical:0,truncated:false,gridBotsAtRisk:1,cancellationsComplete:false,botsPaused:{paused:0,total:2},
  ages:{workerCheckInSeconds:2,monitorPollSeconds:5,observedAt:'2026-10-25T00:00:00.000Z'},...patch};}
export function incident(patch:Partial<WorkerIncident>={}):WorkerIncident{return {id:fixtureId(1),bot_id:fixtureId(2),code:'stop_failed',severity:'critical',canAcknowledge:true,
  acknowledged:false,seen:false,resolved_at:null,occurrence_count:1,first_seen_seconds:30,last_seen_seconds:20,resolved_seconds:null,...patch};}
export function presentation(patch:Partial<WorkerPresentation>={}):WorkerPresentation{return {status:status(),admitted:true,overlay:'none',elapsedSeconds:0,target:null,outcome:null,notice:'',busy:false,...patch};}
export const fixtureNames=new Map([[fixtureId(2),'Long horizon grid for steady market conditions '.repeat(4)],[fixtureId(3),'Evening grid'],[fixtureId(4),'Weekend grid']]);
export function renderCases():[string,WorkerPresentation][]{
  const cases:[string,WorkerPresentation][]=cardStates.map(cardState=>[cardState,presentation({status:status({cardState,entriesPaused:['paused','legacy_paused','pause_unconfirmed'].includes(cardState),
    executionMode:cardState.startsWith('legacy')?'legacy':'external',host:{legacy_controls_enabled:true,observer_fenced:cardState==='attention_fence'},
    executionRestrictions:cardState==='test'?['test']:cardState==='exec_off'?['trading_off']:cardState==='attention_drain'?['drain']:[],
    incidents:cardState==='needs_you'||cardState==='check_bots'?[incident()]:[],unacknowledgedCritical:cardState==='needs_you'||cardState==='check_bots'?1:0})})]);
  for(const overlay of ['stale','checking','signing','pausing','save_unknown','resuming'] as const)cases.push(['overlay-'+overlay,presentation({overlay,target:{action:'pause',target:'all'},busy:!['stale','checking','save_unknown'].includes(overlay)})]);
  for(const executionMode of ['legacy','external'] as const)for(const restriction of ['test','trading_off','drain','EXAMPLE_UNKNOWN'])cases.push([executionMode+'-'+restriction,presentation({status:status({executionMode,cardState:'needs_you',host:{legacy_controls_enabled:true,observer_fenced:false},executionRestrictions:[restriction],incidents:[incident()],unacknowledgedCritical:1})})]);
  cases.push(['unknown-state',presentation({status:status({cardState:'EXAMPLE_UNKNOWN'})})],['unknown-code',presentation({status:status({incidents:[incident({code:'EXAMPLE_UNKNOWN',severity:'warning',canAcknowledge:false})],unacknowledgedCritical:1})})],
    ['truncated',presentation({status:status({incidents:[incident()],unacknowledgedCritical:120,acknowledgedCritical:3,truncated:true})})],
    ['multiple-names',presentation({status:status({incidents:[2,3,4].map(n=>incident({id:fixtureId(n+10),bot_id:fixtureId(n),code:'quota_pressure',severity:'warning',canAcknowledge:false})),incidentCounts:{warning:3}})})],
    ['phone-off',presentation({status:status({ages:{workerCheckInSeconds:3,monitorPollSeconds:200,observedAt:'2026-10-25T00:00:00.000Z'}})})],
    ['phone-no-risk',presentation({status:status({gridBotsAtRisk:0,ages:{workerCheckInSeconds:3,monitorPollSeconds:null,observedAt:'2026-10-25T00:00:00.000Z'}})})],
    ['non-owner',presentation({admitted:false})],['dormant',presentation({status:status({executionMode:'legacy'})})]);
  for(const code of Object.keys(incidentCopy))cases.push(['incident-'+code,presentation({status:status({incidents:[incident({code})],unacknowledgedCritical:1})})]);
  for(const notice of Object.keys(outcomeCopy) as (keyof typeof outcomeCopy)[])cases.push(['outcome-'+notice,presentation({notice:outcomeCopy[notice]})]);
  for(const action of ['reset_pause','ack_critical'] as const)cases.push(['signing-'+action,presentation({overlay:'signing',target:{action,target:action==='ack_critical'?'incident:'+fixtureId(1):'all'},busy:true})]);
  cases.push(['timeout',presentation({status:status({entriesPaused:true,cardState:'pause_unconfirmed'}),outcome:{saved:true,pauseRevision:'3',acknowledgementOutcome:'timeout'}})],
    ['no-check-in',presentation({status:status({cardState:'offline',ages:{workerCheckInSeconds:null,monitorPollSeconds:null,observedAt:'2026-10-25T00:00:00.000Z'}})})],
    ['phone-fenced',presentation({status:status({host:{legacy_controls_enabled:false,observer_fenced:true},unacknowledgedCritical:1,ages:{workerCheckInSeconds:3,monitorPollSeconds:310,observedAt:'2026-10-25T00:00:00.000Z'}})})],
    ['acknowledged-event',presentation({status:status({incidents:[incident({acknowledged:true,canAcknowledge:false})],acknowledgedCritical:1})})],
    ['acknowledged-condition',presentation({status:status({incidents:[incident({code:'progress_stale',acknowledged:true,canAcknowledge:false})],acknowledgedCritical:1})})],
    ['cleared-alert',presentation({status:status({incidents:[incident({resolved_at:'2026-10-25T00:00:00.000Z'})],unacknowledgedCritical:1})})],
    ['pause-complete',presentation({status:status({cardState:'paused',entriesPaused:true,pauseAckRevision:'3',cancellationsComplete:true,botsPaused:{paused:2,total:2}})})]);
  return cases;
}
