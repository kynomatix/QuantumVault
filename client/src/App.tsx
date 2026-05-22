import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WalletProvider } from "@/components/WalletProvider";
import { ConfirmDialogProvider } from "@/hooks/useConfirm";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import NotFound from "@/pages/not-found";
import Landing from "@/pages/Landing";
import AppPage from "@/pages/App";
import DocsPage from "@/pages/Docs";
import Analytics from "@/pages/Analytics";
import PitchDeck from "@/pages/PitchDeck";
import PitchDeckV2 from "@/pages/PitchDeckV2";
import Admin from "@/pages/Admin";
import QuantumLab from "@/pages/QuantumLab";
import MarketplaceBotPage from "@/pages/MarketplaceBotPage";
import TelegramMiniApp from "@/pages/TelegramMiniApp";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/app" component={AppPage} />
      <Route path="/docs" component={DocsPage} />
      <Route path="/analytics" component={Analytics} />
      <Route path="/pitch-deck" component={PitchDeck} />
      <Route path="/pitch-deck-v2" component={PitchDeckV2} />
      <Route path="/admin" component={Admin} />
      <Route path="/quantumlab" component={QuantumLab} />
      <Route path="/marketplace/:id" component={MarketplaceBotPage} />
      <Route path="/tg" component={TelegramMiniApp} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <WalletProvider>
          <TooltipProvider>
            <ConfirmDialogProvider>
              <Toaster />
              <Router />
            </ConfirmDialogProvider>
          </TooltipProvider>
        </WalletProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
