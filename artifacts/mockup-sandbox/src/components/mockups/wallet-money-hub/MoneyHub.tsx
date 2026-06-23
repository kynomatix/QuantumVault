import "./_group.css";
import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Wallet, 
  Bot, 
  ArrowDownToLine, 
  ArrowUpFromLine, 
  RefreshCw, 
  Copy, 
  Check, 
  ExternalLink, 
  ShieldCheck, 
  KeyRound,
  ArrowRight,
  Fuel,
  History,
  Info
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";

export default function MoneyHub() {
  const [copiedWallet, setCopiedWallet] = useState(false);
  const [copiedAgent, setCopiedAgent] = useState(false);
  const [activeTab, setActiveTab] = useState("deposit");

  const walletAddress = "7xPd...9pL2";
  const agentAddress = "4kMt...2aB1";

  const handleCopy = (type: "wallet" | "agent") => {
    if (type === "wallet") {
      setCopiedWallet(true);
      setTimeout(() => setCopiedWallet(false), 2000);
    } else {
      setCopiedAgent(true);
      setTimeout(() => setCopiedAgent(false), 2000);
    }
  };

  return (
    <div className="dark min-h-screen bg-background text-foreground font-sans selection:bg-primary/30">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 space-y-12">
        
        {/* Header */}
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col md:flex-row md:items-end justify-between gap-6"
        >
          <div className="space-y-2">
            <h1 className="text-4xl font-semibold tracking-tight">Money Hub</h1>
            <p className="text-lg text-muted-foreground">Manage your automated trading funds.</p>
          </div>
          <Button variant="outline" className="shrink-0 rounded-full h-10 px-5 bg-card/50 border-border/40 hover:bg-card">
            <RefreshCw className="w-4 h-4 mr-2 text-muted-foreground" />
            Refresh Balances
          </Button>
        </motion.div>

        {/* Top Balances Row */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Personal Wallet */}
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <Card className="h-full bg-card/40 border-border/40 backdrop-blur-xl shadow-card transition-all hover:bg-card/60">
              <CardContent className="p-8">
                <div className="flex justify-between items-start mb-8">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
                      <Wallet className="w-6 h-6 text-primary" />
                    </div>
                    <div>
                      <h2 className="font-medium text-foreground">Your Wallet</h2>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-muted-foreground font-mono">{walletAddress}</span>
                        <button onClick={() => handleCopy("wallet")} className="text-muted-foreground hover:text-foreground transition-colors">
                          {copiedWallet ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>
                  </div>
                  <Badge variant="secondary" className="bg-primary/10 text-primary hover:bg-primary/20 font-medium">Connected</Badge>
                </div>
                
                <div className="space-y-6">
                  <div>
                    <div className="text-sm font-medium text-muted-foreground mb-1">USDC Balance</div>
                    <div className="text-4xl font-semibold tracking-tight">
                      <span className="text-muted-foreground/60 mr-1">$</span>1,250<span className="text-2xl text-muted-foreground">.40</span>
                    </div>
                  </div>
                  
                  <div className="pt-6 border-t border-border/30 flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">SOL Balance</span>
                    <span className="font-medium text-foreground">2.31 SOL</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>

          {/* Trading Agent */}
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
          >
            <Card className="h-full bg-gradient-to-br from-card to-card/60 border-primary/20 shadow-elevated relative overflow-hidden">
              <div className="absolute top-0 right-0 p-32 bg-primary/5 blur-[100px] rounded-full pointer-events-none" />
              <CardContent className="p-8 relative z-10">
                <div className="flex justify-between items-start mb-8">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-primary/20 flex items-center justify-center">
                      <Bot className="w-6 h-6 text-primary" />
                    </div>
                    <div>
                      <h2 className="font-medium text-foreground">Trading Agent</h2>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-muted-foreground font-mono">{agentAddress}</span>
                        <button onClick={() => handleCopy("agent")} className="text-muted-foreground hover:text-foreground transition-colors">
                          {copiedAgent ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                        <a href="#" className="text-muted-foreground hover:text-primary transition-colors ml-1">
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    </div>
                  </div>
                  <Badge className="bg-primary/20 text-primary hover:bg-primary/30 border-0 font-medium">Active</Badge>
                </div>
                
                <div className="space-y-6">
                  <div>
                    <div className="text-sm font-medium text-muted-foreground mb-1">Trading Capital</div>
                    <div className="text-4xl font-semibold tracking-tight text-foreground">
                      <span className="text-muted-foreground/60 mr-1">$</span>4,820<span className="text-2xl text-muted-foreground">.16</span>
                    </div>
                  </div>
                  
                  <div className="pt-6 border-t border-border/30 flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Gas Buffer</span>
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.6)]" />
                      <span className="font-medium text-foreground">0.18 SOL</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>

        {/* Action Center & Activity */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          {/* Main Action Area */}
          <motion.div 
            className="lg:col-span-2 space-y-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <Card className="bg-card border-border/50 shadow-card overflow-hidden">
              <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                <div className="border-b border-border/50 px-6 py-4 bg-muted/20">
                  <TabsList className="bg-transparent space-x-6 p-0 h-auto">
                    <TabsTrigger 
                      value="deposit" 
                      className="px-0 py-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:text-primary rounded-none border-b-2 border-transparent data-[state=active]:border-primary text-base font-medium text-muted-foreground hover:text-foreground transition-all"
                    >
                      Deposit
                    </TabsTrigger>
                    <TabsTrigger 
                      value="withdraw" 
                      className="px-0 py-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:text-primary rounded-none border-b-2 border-transparent data-[state=active]:border-primary text-base font-medium text-muted-foreground hover:text-foreground transition-all"
                    >
                      Withdraw
                    </TabsTrigger>
                    <TabsTrigger 
                      value="gas" 
                      className="px-0 py-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:text-orange-500 rounded-none border-b-2 border-transparent data-[state=active]:border-orange-500 text-base font-medium text-muted-foreground hover:text-foreground transition-all"
                    >
                      Gas (SOL)
                    </TabsTrigger>
                  </TabsList>
                </div>

                <div className="p-8">
                  <AnimatePresence mode="wait">
                    
                    {/* DEPOSIT TAB */}
                    {activeTab === "deposit" && (
                      <motion.div
                        key="deposit"
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 10 }}
                        className="space-y-8"
                      >
                        <div className="space-y-2">
                          <h3 className="text-xl font-semibold">Fund your agent</h3>
                          <p className="text-muted-foreground">Move USDC straight from your wallet into the trading agent.</p>
                        </div>

                        <div className="bg-muted/30 p-6 rounded-2xl border border-border/50 space-y-5">
                          <div className="flex justify-between items-center mb-2">
                            <Label className="text-sm font-medium text-muted-foreground">Amount (USDC)</Label>
                            <span className="text-sm text-muted-foreground">Available: 1,250.40 USDC</span>
                          </div>
                          <div className="relative flex items-center">
                            <span className="absolute left-4 text-xl text-muted-foreground">$</span>
                            <Input 
                              type="text" 
                              placeholder="0.00" 
                              className="pl-8 text-2xl h-14 bg-background border-border/50 rounded-xl" 
                            />
                            <Button variant="ghost" className="absolute right-2 h-10 text-primary hover:text-primary hover:bg-primary/10">Max</Button>
                          </div>
                          <div className="flex items-center justify-center pt-2">
                            <div className="flex items-center gap-4 text-sm font-medium text-muted-foreground">
                              <span>Your Wallet</span>
                              <ArrowRight className="w-4 h-4 text-primary" />
                              <span className="text-primary">Trading Agent</span>
                            </div>
                          </div>
                        </div>

                        <Button size="lg" className="w-full h-14 text-lg rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground shadow-glow">
                          <ArrowDownToLine className="w-5 h-5 mr-2" />
                          Deposit USDC
                        </Button>

                        <div className="relative">
                          <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-border/50" /></div>
                          <div className="relative flex justify-center text-xs uppercase"><span className="bg-card px-2 text-muted-foreground tracking-wider">Or</span></div>
                        </div>

                        <div className="bg-accent/5 border border-accent/20 rounded-2xl p-6 relative overflow-hidden group hover:bg-accent/10 transition-colors cursor-pointer">
                          <div className="flex items-start gap-4 relative z-10">
                            <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center shrink-0">
                              <SparklesIcon className="w-5 h-5 text-accent" />
                            </div>
                            <div className="space-y-1">
                              <h4 className="font-medium text-foreground">Auto-Swap Deposit</h4>
                              <p className="text-sm text-muted-foreground leading-relaxed">Deposit SOL, BONK, or any token — we auto-swap it to USDC and fund your agent.</p>
                            </div>
                            <ArrowRight className="w-5 h-5 text-accent/50 absolute right-0 top-1/2 -translate-y-1/2 group-hover:text-accent group-hover:translate-x-1 transition-all" />
                          </div>
                        </div>
                      </motion.div>
                    )}

                    {/* WITHDRAW TAB */}
                    {activeTab === "withdraw" && (
                      <motion.div
                        key="withdraw"
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 10 }}
                        className="space-y-8"
                      >
                        <div className="space-y-2">
                          <h3 className="text-xl font-semibold">Withdraw to wallet</h3>
                          <p className="text-muted-foreground">Pull trading capital from your agent back to your personal wallet.</p>
                        </div>

                        <div className="bg-muted/30 p-6 rounded-2xl border border-border/50 space-y-5">
                          <div className="flex justify-between items-center mb-2">
                            <Label className="text-sm font-medium text-muted-foreground">Amount (USDC)</Label>
                            <span className="text-sm text-muted-foreground">Available: 4,820.16 USDC</span>
                          </div>
                          <div className="relative flex items-center">
                            <span className="absolute left-4 text-xl text-muted-foreground">$</span>
                            <Input 
                              type="text" 
                              placeholder="0.00" 
                              className="pl-8 text-2xl h-14 bg-background border-border/50 rounded-xl" 
                            />
                            <Button variant="ghost" className="absolute right-2 h-10 text-primary hover:text-primary hover:bg-primary/10">Max</Button>
                          </div>
                          <div className="flex items-center justify-center pt-2">
                            <div className="flex items-center gap-4 text-sm font-medium text-muted-foreground">
                              <span className="text-primary">Trading Agent</span>
                              <ArrowRight className="w-4 h-4 text-primary" />
                              <span>Your Wallet</span>
                            </div>
                          </div>
                        </div>

                        <Button size="lg" className="w-full h-14 text-lg rounded-xl bg-card border border-border hover:bg-muted text-foreground">
                          <ArrowUpFromLine className="w-5 h-5 mr-2" />
                          Withdraw USDC
                        </Button>
                      </motion.div>
                    )}

                    {/* GAS TAB */}
                    {activeTab === "gas" && (
                      <motion.div
                        key="gas"
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 10 }}
                        className="space-y-8"
                      >
                        <div className="space-y-4">
                          <div className="flex items-start gap-4">
                            <div className="w-12 h-12 rounded-2xl bg-orange-500/10 flex items-center justify-center shrink-0">
                              <Fuel className="w-6 h-6 text-orange-500" />
                            </div>
                            <div>
                              <h3 className="text-xl font-semibold">Gas Buffer</h3>
                              <p className="text-muted-foreground mt-1">SOL is required to pay transaction fees on Solana. Keep your agent topped up to ensure seamless trading.</p>
                            </div>
                          </div>
                        </div>

                        <div className="bg-orange-500/5 border border-orange-500/20 rounded-2xl p-6">
                          <div className="flex justify-between items-center mb-6">
                            <div>
                              <p className="text-sm font-medium text-orange-500/80 mb-1">Current Agent Gas</p>
                              <p className="text-3xl font-semibold text-foreground">0.18 <span className="text-xl text-muted-foreground font-normal">SOL</span></p>
                            </div>
                            <Badge variant="outline" className="bg-orange-500/10 text-orange-500 border-orange-500/20">Healthy</Badge>
                          </div>
                          <div className="space-y-2 mb-6">
                            <div className="text-sm text-muted-foreground flex items-center gap-2">
                              <Info className="w-4 h-4 text-orange-500/60 shrink-0" />
                              We recommend keeping at least 0.1 SOL for smooth operations.
                            </div>
                            <p className="text-xs text-muted-foreground/80 pl-6">
                              We automatically keep ~0.01 SOL in your wallet and ~0.005 SOL in your agent for transaction fees.
                            </p>
                          </div>

                          <div className="grid grid-cols-2 gap-4">
                            <Button size="lg" className="h-12 bg-orange-500 hover:bg-orange-600 text-white rounded-xl shadow-[0_4px_14px_rgba(249,115,22,0.3)]">
                              <ArrowDownToLine className="w-4 h-4 mr-2" />
                              Top Up SOL
                            </Button>
                            <Button size="lg" variant="outline" className="h-12 rounded-xl border-border/60 hover:bg-card">
                              Withdraw SOL
                            </Button>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </Tabs>
            </Card>
          </motion.div>

          {/* Right Column: Activity & Safety */}
          <motion.div 
            className="space-y-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25 }}
          >
            {/* Recent Activity */}
            <Card className="bg-card/50 border-border/40 backdrop-blur-sm shadow-card">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg flex items-center gap-2">
                  <History className="w-5 h-5 text-muted-foreground" />
                  Recent Activity
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                        <ArrowDownToLine className="w-4 h-4 text-primary" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">Deposit USDC</p>
                        <p className="text-xs text-muted-foreground">Today, 2:41 PM</p>
                      </div>
                    </div>
                    <span className="text-sm font-medium text-foreground">+$500.00</span>
                  </div>
                  
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center">
                        <SparklesIcon className="w-4 h-4 text-accent" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">Auto-Swap Deposit</p>
                        <p className="text-xs text-muted-foreground">Yesterday</p>
                      </div>
                    </div>
                    <span className="text-sm font-medium text-foreground">+$245.10</span>
                  </div>

                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-orange-500/10 flex items-center justify-center">
                        <Fuel className="w-4 h-4 text-orange-500" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">Top Up Gas</p>
                        <p className="text-xs text-muted-foreground">Oct 12</p>
                      </div>
                    </div>
                    <span className="text-sm font-medium text-foreground">+0.2 SOL</span>
                  </div>
                </div>
                <Button variant="ghost" className="w-full text-muted-foreground hover:text-foreground text-sm h-8 mt-2">
                  View full history
                </Button>
              </CardContent>
            </Card>

            {/* Safety Drawer */}
            <Card className="bg-transparent border border-border/30 border-dashed overflow-hidden">
              <CardContent className="p-5 space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-muted/40 flex items-center justify-center">
                    <ShieldCheck className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">Safety & Recovery</p>
                    <p className="text-xs text-muted-foreground">Rarely needed. Here if you ever do.</p>
                  </div>
                </div>

                <div className="space-y-1">
                  <button className="w-full flex items-center justify-between rounded-lg px-3 py-2.5 text-left group hover:bg-muted/40 transition-colors">
                    <div className="flex items-center gap-3">
                      <ArrowDownToLine className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
                      <div>
                        <p className="text-sm text-foreground">Recover stranded funds</p>
                        <p className="text-xs text-muted-foreground">Sweep funds left in closed or orphaned accounts.</p>
                      </div>
                    </div>
                    <ArrowRight className="w-4 h-4 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors shrink-0" />
                  </button>

                  <button className="w-full flex items-center justify-between rounded-lg px-3 py-2.5 text-left group hover:bg-muted/40 transition-colors">
                    <div className="flex items-center gap-3">
                      <KeyRound className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
                      <div>
                        <p className="text-sm text-foreground">Reveal recovery phrase</p>
                        <p className="text-xs text-muted-foreground">Back up your agent's secret phrase securely.</p>
                      </div>
                    </div>
                    <ArrowRight className="w-4 h-4 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors shrink-0" />
                  </button>
                </div>
              </CardContent>
            </Card>
            
          </motion.div>
        </div>

      </div>
    </div>
  );
}

export { MoneyHub };

function SparklesIcon(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
      <path d="M5 3v4" />
      <path d="M19 17v4" />
      <path d="M3 5h4" />
      <path d="M17 19h4" />
    </svg>
  );
}
