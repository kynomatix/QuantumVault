import { Link } from "wouter";
import { Vault as VaultIcon, ArrowLeft } from "lucide-react";
import VaultIdleFunds from "@/components/VaultIdleFunds";

export default function Vaults() {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 h-14 bg-background/80 backdrop-blur-xl border-b border-border/50 flex items-center px-4 lg:px-6">
        <Link
          href="/app"
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          data-testid="link-back-app"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to app
        </Link>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-full bg-primary/20">
            <VaultIcon className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="font-display font-bold text-2xl" data-testid="text-vaults-title">
              Vault
            </h1>
            <p className="text-sm text-muted-foreground">
              Earn yield on idle USDC. Your funds stay in your own wallet.
            </p>
          </div>
        </div>

        <section className="gradient-border p-0 noise">
          <div className="p-4 sm:p-6">
            <VaultIdleFunds active />
          </div>
        </section>
      </main>
    </div>
  );
}
