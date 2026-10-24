export type GridAction = 'start' | 'resume' | 'cycle' | 'cancel' | 'close' | 'sweep' | 'settle' | 'claim' | 'release' | 'read';
export interface KillContext {
  role: 'legacy' | 'grid-worker' | 'protective'; executionMode: 'legacy' | 'external';
  legacyControlsEnabled: boolean; runMode: 'test' | 'trading'; executionEnabled: boolean;
  entriesPaused: boolean; drainRequested: boolean; observerFenced: boolean;
  holderValid: boolean; identityValid: boolean; authorityValid: boolean;
  alreadyOwned: boolean; terminalProof: boolean; scopeAndConsent: boolean;
  retainedAuthority: boolean; signedPolicy: boolean; protectiveDrain: boolean;
}
/** Both A1.5 matrices intersect. Read access never implies a mutation or a claim. */
export function gridActionAllowed(action: GridAction, c: KillContext): boolean {
  if (action === 'read') return true;
  if (!c.identityValid) return false;
  if (c.executionMode === 'legacy') { if (c.role !== 'legacy' || !c.holderValid) return false; }
  else if (c.role === 'legacy' || !c.holderValid) return false;
  if (c.role === 'protective' && !['cancel', 'close', 'settle'].includes(action)) return false;
  const controls = c.executionMode === 'external' || c.legacyControlsEnabled;
  if (controls && c.runMode === 'test') return false;
  if (!c.authorityValid || controls && !c.executionEnabled) return action === 'settle';
  if (controls) {
    if (c.entriesPaused && ['start', 'resume', 'cycle'].includes(action)) return false;
    if (c.observerFenced && ['start', 'resume'].includes(action)) return false;
    if (c.drainRequested) {
      if (['start', 'resume', 'cycle', 'claim'].includes(action)) return false;
      if (['cancel', 'close'].includes(action) && !(c.alreadyOwned && c.protectiveDrain)) return false;
      if (['sweep', 'release'].includes(action) && !(c.alreadyOwned && c.terminalProof)) return false;
    }
  }
  if (action === 'sweep' || action === 'release') return c.terminalProof && c.alreadyOwned;
  if (action === 'start') return c.scopeAndConsent;
  if (action === 'resume') return c.retainedAuthority;
  if (action === 'cycle') return c.signedPolicy && c.alreadyOwned;
  return true;
}
