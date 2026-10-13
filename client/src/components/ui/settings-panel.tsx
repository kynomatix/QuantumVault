import { useId, type ElementType, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

export function DrawerSettingsPanel({
  id,
  expandedPanel,
  setExpandedPanel,
  icon: Icon,
  title,
  destructive = false,
  testId,
  bodyClassName = 'space-y-4',
  keepMounted = false,
  children,
}: {
  id: string;
  expandedPanel: string | null;
  setExpandedPanel: (v: string | null) => void;
  icon: ElementType;
  title: string;
  destructive?: boolean;
  testId?: string;
  bodyClassName?: string;
  keepMounted?: boolean;
  children: ReactNode;
}) {
  const panelId = useId();
  const open = expandedPanel === id;
  return (
    <div className={`rounded-xl border ${destructive ? 'border-destructive/30 bg-destructive/5' : 'border-border/50 bg-muted/20'}`}>
      <button
        type="button"
        id={`${panelId}-trigger`}
        aria-expanded={open}
        aria-controls={`${panelId}-body`}
        onClick={() => setExpandedPanel(open ? null : id)}
        className="w-full p-4 flex items-center justify-between cursor-pointer hover:bg-muted/10 transition-colors rounded-xl"
        data-testid={testId}
      >
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-full ${destructive ? 'bg-destructive/20' : 'bg-primary/20'}`}>
            <Icon aria-hidden="true" className={`w-4 h-4 ${destructive ? 'text-destructive' : 'text-primary'}`} />
          </div>
          <h3 className={`font-semibold text-sm ${destructive ? 'text-destructive' : ''}`}>{title}</h3>
        </div>
        <ChevronDown aria-hidden="true" className={`w-4 h-4 text-muted-foreground transition-transform shrink-0 ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence initial={false}>
        {(open || keepMounted) && (
          <motion.div
            id={`${panelId}-body`}
            role="region"
            aria-labelledby={`${panelId}-trigger`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: open ? 'auto' : 0, opacity: open ? 1 : 0 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
            aria-hidden={open ? undefined : true}
            inert={open ? undefined : true}
          >
            <div className={`px-4 pb-4 ${bodyClassName}`}>
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
