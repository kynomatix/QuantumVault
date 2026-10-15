import type {GridStartRequest, GridStartResult} from '../../shared/grid-start';
import type {GridPolicy} from './policy-hmac';
import {GridStorageError} from './storage';

export interface GridStartDraft extends GridStartRequest {
  status: string;
  policy: GridPolicy;
  policyHmac: string;
}
export interface GridStartDeps {
  read(wallet: string, id: string): Promise<GridStartDraft | null>;
  provision(wallet: string, draft: GridStartDraft, signal: AbortSignal): Promise<Pick<GridStartResult, 'state' | 'reason'>>;
}
/** Custody's locked draft CAS is the cross-process admission authority. Never replay a reserved launch here. */
export async function startRetainedGrid(wallet: string, id: string, expected: GridStartRequest, signal: AbortSignal, deps: GridStartDeps): Promise<GridStartResult> {
  const read = async () => {
    const draft = await deps.read(wallet, id);
    if (!draft) throw new GridStorageError('not_found');
    if (draft.policy.id !== id || draft.draftRevision !== expected.draftRevision || draft.serverIntentDigest !== expected.serverIntentDigest)
      throw new GridStorageError('conflict');
    return draft;
  };
  const retained = (draft: GridStartDraft): GridStartResult => ({launchId: id,
    state: ['canary', 'active'].includes(draft.status) ? 'canary' : 'pending',
    reason: 'Launch retained: '+draft.status.replaceAll('_',' ')+'. Open bot details for current exchange and settlement state.'});
  const draft = await read();
  if (draft.status !== 'draft') return retained(draft);
  signal.throwIfAborted();
  try { return {launchId: id, ...await deps.provision(wallet, draft, signal)}; }
  catch (error) {
    // Another request may have won admission, or this request may have lost its reply after admission.
    const current = await read();
    if (current.status !== 'draft') return retained(current);
    throw error;
  }
}
