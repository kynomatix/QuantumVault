import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

export type ConfirmOptions = {
  title: string;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: "default" | "destructive";
};

type Resolver = (value: boolean) => void;

const ConfirmContext = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<Resolver | null>(null);
  const actionBtnRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback((next: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      if (resolverRef.current) {
        resolverRef.current(false);
      }
      resolverRef.current = resolve;
      setOpts(next);
      setOpen(true);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (resolverRef.current) {
        resolverRef.current(false);
        resolverRef.current = null;
      }
    };
  }, []);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next && resolverRef.current) {
      resolverRef.current(false);
      resolverRef.current = null;
    }
  }, []);

  const handleConfirm = useCallback(() => {
    if (resolverRef.current) {
      resolverRef.current(true);
      resolverRef.current = null;
    }
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => actionBtnRef.current?.focus(), 50);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [open, handleConfirm]);

  const isDestructive = (opts?.variant ?? "destructive") === "destructive";

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={open} onOpenChange={handleOpenChange}>
        <AlertDialogContent
          className="border-white/10 bg-zinc-950/95 backdrop-blur-xl text-white shadow-2xl"
          data-testid="confirm-dialog"
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white">{opts?.title ?? ""}</AlertDialogTitle>
            {opts?.description && (
              <AlertDialogDescription className="text-white/60">
                {opts.description}
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              className="bg-white/5 border-white/10 text-white hover:bg-white/10 hover:text-white"
              data-testid="confirm-dialog-cancel"
            >
              {opts?.cancelText ?? "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              ref={actionBtnRef}
              onClick={handleConfirm}
              className={cn(
                isDestructive
                  ? "bg-red-500/90 text-white hover:bg-red-500"
                  : "bg-sky-500/90 text-white hover:bg-sky-500",
              )}
              data-testid="confirm-dialog-action"
            >
              {opts?.confirmText ?? "Confirm"}
              <span className="ml-2 hidden sm:inline-flex items-center gap-1 rounded border border-white/20 px-1.5 py-0.5 text-[10px] font-mono opacity-70">
                ↵
              </span>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within <ConfirmDialogProvider>");
  return ctx;
}
