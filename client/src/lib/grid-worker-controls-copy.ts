import type {ControlBlocker} from '../../../shared/grid-worker-controls';
import type {ControlKind} from './grid-worker-controls-state';
export const controlCopy={
  changed:'Status changed while you were reading. Check the details again.',
  prepare:"Couldn't prepare the signature. Refresh and try again.",
  expired:'This signature expired. Review the details and sign again.',
  unknown:"Still checking. Don't sign again yet.",
  unavailable:"This isn't available right now. Check again.",
  wallet:'Your wallet shows this message. Sign only if it matches exactly.',
  fingerprint:'The params line is a fingerprint of every setting this page received for this change, including those listed above. This page worked it out itself, and it matches.',
  waiting:'Until the worker takes control, it cannot place orders or run stops.',
  fallback:'Stop the worker app first. Wait until the server confirms that nothing holds control and all checks are clear. After signing, restart the worker, wait for its checks, then resume new activity.',
};
export const controlLabels:Record<ControlKind,{title:string;button:string;sign:string;tick:string;done:string;signing:string;sending:string}>={
  handover:{title:'Hand grid bots to the worker',button:'Hand over to the worker in test mode',sign:'Sign handover',tick:"I understand there's no way back to the old mode.",done:'The handover to worker test mode completed.',signing:'Check your wallet to sign the handover.',sending:'Handover sent. The server is checking every grid account on Pacifica before it saves the change.'},
  trading:{title:'Turn on trading',button:'Turn on trading',sign:'Sign: turn on trading',tick:"I understand bots can place real orders, and there's no way back to test mode.",done:'Trading was turned on. Check the current status below.',signing:'Check your wallet to sign turning on trading.',sending:'Sent. The server is checking every grid account on Pacifica before it turns on trading.'},
  renewal:{title:'Renew limits',button:'Renew limits',sign:'Sign renewal',tick:'I understand this keeps the same request limits and extends their end date.',done:'This renewal was saved. Check the current limits below.',signing:'Check your wallet to sign the renewal.',sending:'Renewal sent. Waiting for the server to save it.'},
};
export const controlReasons:Record<ControlBlocker,string>={
  not_flat:'A grid account on Pacifica still holds a position, an order or a balance.',
  evidence_unavailable:"The server couldn't read Pacifica to check the grid accounts.",
  changed:controlCopy.changed,
  open_alert:'Every red alert below must be acknowledged and cleared first.',
  needs_review:"A red alert needs a reviewed fix before this can be signed. Acknowledging it isn't enough.",
  bots_active:'Every grid bot, for every user, must be stopped first.',
  settling:"Earlier orders or transfers are still being confirmed. This opens once they're settled.",
  limits_expired:'Request limits have ended. Renew them first.',
  limits_busy:'Request capacity is not available for these checks. Check again.',
  identity:"The main app's version couldn't be verified, so this can't be signed yet.",
  holder:'Stop the worker app first. Wait until the server confirms that nothing holds control.',
  worker_unhealthy:'The worker must confirm the pause and clear its checks before it is stopped.',
  history:'Exchange history checks must finish first.',
  rescue:'This waits until the rescue close ends and any unknown order is settled.',
  scope:"A grid account isn't under your owner key, so the server can't check it.",
  expired:controlCopy.expired,
  not_paused:'New grid activity must be paused first.',
  owner_key:"Your owner key isn't set up in this version yet.",
  tracking:"Wallet tracking isn't on for every wallet yet.",
  drain:"A handover has been requested, so this can't start.",
  invalid:"The proposed change didn't pass the server's checks.",
  not_extending:'The proposed end date does not extend both request limits.',
  unequal_dates:'The proposed request limits have different end dates.',
  already_renewed:'The request limits already have this end date or a later one.',
  unavailable:controlCopy.unavailable,
};
export const refusedControl=(kind:ControlKind,reason:ControlBlocker)=>(kind==='renewal'?'This request did not renew the limits.':"This request did not change the worker's mode.")+' '+controlReasons[reason];
export const limitDate=(date:string)=>new Date(date).toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short',year:'numeric'});
