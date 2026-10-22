import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { gridRememberMode, gridSetupScreen, type GridSetupMode } from '@/lib/grid-simple-view';
import { GridSetupModeSelect } from './GridSetupModeSelect';
import { GridPlannerSheet } from './GridPlannerSheet';
type Props = React.ComponentProps<typeof GridPlannerSheet> & { sourceBotId?: string };
/** No planner effects mount until a mode is chosen. Identity changes discard the entire session. */
export function GridSetupEntry(props: Props) {
  return <EntrySession key={props.identity} {...props} />;
}
function EntrySession(props: Props) {
  const [screen, setScreen] = useState(() => gridSetupScreen(props.identity, props.initialIntent, props.sourceBotId));
  const choose = (mode: GridSetupMode) => { gridRememberMode(props.identity, mode); setScreen(mode); };
  if (screen !== 'chooser') return <GridPlannerSheet {...props} initialMode={screen} />;
  return <Dialog open={props.open} onOpenChange={props.onOpenChange}>
    <DialogContent className="max-w-lg sm:max-w-[760px] max-h-[90dvh] overflow-y-auto">
      <DialogHeader><DialogTitle>How do you want to set up your grid bot?</DialogTitle><DialogDescription>You can switch at any time.</DialogDescription></DialogHeader>
      <GridSetupModeSelect onSelect={choose} />
    </DialogContent>
  </Dialog>;
}
