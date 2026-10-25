import {createHash} from 'node:crypto';
import type {WorkerRescue} from '../../client/src/lib/grid-worker-rescue-wire';
import {emptyRescueDriver} from '../../client/src/lib/grid-worker-rescue-state';
import {rescueBlockers,rescueCopy,rescuePhases,rescueRefusals,rescueTriggers} from '../../client/src/lib/grid-worker-rescue-copy';
import type {RescueViewProps} from '../../client/src/components/grid-bot/GridWorkerRescueView';
import {fixtureId,fixtureNames,incident,presentation,status} from './grid-worker-u5b-fixtures';
export const rescueKeyHash=createHash('sha256').update('EXAMPLE').digest('hex');
export function rescue(patch:Partial<WorkerRescue>={}):WorkerRescue{return {requestId:fixtureId(10),requestKey:rescueKeyHash,botId:fixtureId(2),phase:'waiting',live:true,unknownOpen:false,expiresInSeconds:550,completedSeconds:null,stepIdleSeconds:20,leaseRemainingSeconds:25,next:'wait',retryAfterSeconds:2,waitSeconds:12,...patch};}
export function rescueProps(patch:Partial<RescueViewProps>={}):RescueViewProps{return {botId:fixtureId(2),names:fixtureNames,canSign:true,state:presentation({status:status({rescueOffers:[{botId:fixtureId(2),trigger:'worker_unavailable',blockedBy:null}],rescueAlertsPhone:false,stopsAllowed:false})}),...patch};}
export function rescueCases():[string,RescueViewProps][]{
  const cases:[string,RescueViewProps][]=[];
  for(const trigger of Object.keys(rescueTriggers))cases.push(['offer-'+trigger,rescueProps({state:presentation({status:status({rescueOffers:[{botId:fixtureId(2),trigger,blockedBy:null}]})})})]);
  for(const blockedBy of [...Object.keys(rescueBlockers),'EXAMPLE_UNKNOWN','constructor'])cases.push(['blocker-'+blockedBy,rescueProps({state:presentation({status:status({rescueOffers:[{botId:fixtureId(2),trigger:'worker_stalled',blockedBy}]})})})]);
  cases.push(['confirm',rescueProps({confirming:true})],['stale-offer',rescueProps({state:{...rescueProps().state,overlay:'stale'}})]);
  for(const phase of [...Object.keys(rescuePhases),'EXAMPLE_UNKNOWN','constructor'])cases.push(['phase-'+phase,rescueProps({state:presentation({status:status({cardState:'rescue_running',rescue:rescue({phase}),stopsAllowed:false})})})]);
  for(const phase of ['complete','partial_ended','unknown_ended','ended','EXAMPLE_UNKNOWN'])for(const completedSeconds of [30,null])cases.push(['outcome-'+phase+'-'+completedSeconds,rescueProps({state:presentation({status:status({rescue:rescue({phase,live:false,next:'done',unknownOpen:phase==='unknown_ended',completedSeconds,stepIdleSeconds:null,leaseRemainingSeconds:null})})})})]);
  for(const [refusal,notice] of Object.entries(rescueRefusals))cases.push(['refusal-'+refusal,rescueProps({driverState:{...emptyRescueDriver,botId:fixtureId(2),mode:'refused',notice}})]);
  for(const mode of ['preparing','signing','starting','uncertain'] as const)cases.push(['local-'+mode,rescueProps({driverState:{...emptyRescueDriver,botId:fixtureId(2),mode}})]);
  cases.push(['phone-old-incident',rescueProps({state:presentation({status:status({rescueAlertsPhone:false,incidents:[incident({code:'protective_failure',acknowledged:true})],rescue:rescue({live:false,next:'done',phase:'partial_ended',completedSeconds:1900})})})})],
    ['stale-live',rescueProps({state:presentation({overlay:'stale',status:status({rescue:rescue(),stopsAllowed:false,executionRestrictions:['test','trading_off','drain']})})})],
    ['non-owner',rescueProps({state:presentation({admitted:false})})],['legacy',rescueProps({state:presentation({status:status({executionMode:'legacy',host:{legacy_controls_enabled:true,observer_fenced:false}})})})],['dormant',rescueProps({state:presentation({status:null,admitted:false})})]);
  for(const [name,notice] of Object.entries(rescueCopy))cases.push(['copy-'+name,rescueProps({driverState:{...emptyRescueDriver,botId:fixtureId(2),mode:'refused',notice}})]);
  return cases;
}
