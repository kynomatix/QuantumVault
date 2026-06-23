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
  Info,
  Coins,
  Bitcoin,
  Sparkles,
  Layers,
  Activity,
  ArrowDownUp
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function MoneyHub() {
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

  const collateralAssets = [
    { name: "USDC", ticker: "USDC", amount: "4,820.16", value: "$4,820", weight: 56, icon: <div className="w-8 h-8 rounded-full bg-blue-500/20 text-blue-500 flex items-center justify-center font-bold text-xs">US</div> },
    { name: "Solana", ticker: "SOL", amount: "14.2", value: "$2,180", weight: 25, icon: <div className="w-8 h-8 rounded-full bg-purple-500/20 text-purple-500 flex items-center justify-center font-bold text-xs">S</div> },
    { name: "Wrapped BTC", ticker: "wBTC", amount: "0.018", value: "$1,150", weight: 13, icon: <div className="w-8 h-8 rounded-full bg-orange-500/20 text-orange-500 flex items-center justify-center"><Bitcoin className="w-4 h-4" /></div> },
    { name: "Wrapped ETH", ticker: "wETH", amount: "0.14", value: "$420", weight: 5, icon: <div className="w-8 h-8 rounded-full bg-indigo-500/20 text-indigo-500 flex items-center justify-center"><Coins className="w-4 h-4" /></div> },
    { name: "Sanctum Infinity", ticker: "INF", amount: "1.9", value: "$70", weight: 1, icon: <div className="w-8 h-8 rounded-full bg-teal-500/20 text-teal-500 flex items-center justify-center"><Layers className="w-4 h-4" /></div> },
  ];

  return (
    <div className="dark min-h-screen bg-background text-foreground font-sans selection:bg-primary/30 pb-20">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 space-y-8">
        
        {/* Header */}
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col md:flex-row md:items-end justify-between gap-6"
        >
          <div className="space-y-2">
            <h1 className="text-4xl font-semibold tracking-tight">Money Hub</h1>
            <p className="text-lg text-muted-foreground">Manage your multi-asset collateral and agent funds.</p>
          </div>
          <Button variant="outline" className="shrink-0 rounded-full h-10 px-5 bg-card/50 border-border/40 hover:bg-card">
            <RefreshCw className="w-4 h-4 mr-2 text-muted-foreground" />
            Refresh Balances
          </Button>
        </motion.div>

        {/* HERO: Multi-Asset Collateral Basket */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <Card className="bg-gradient-to-br from-card to-card/60 border-primary/20 shadow-elevated relative overflow-hidden">
            <div className="absolute top-0 right-0 p-32 bg-primary/5 blur-[100px] rounded-full pointer-events-none" />
            <CardContent className="p-8 relative z-10">
              <div className="flex flex-col md:flex-row gap-12 items-start">
                
                {/* Total Collateral */}
                <div className="flex-1 space-y-6">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-12 h-12 rounded-2xl bg-primary/20 flex items-center justify-center">
                      <Bot className="w-6 h-6 text-primary" />
                    </div>
                    <div>
                      <h2 className="font-medium text-foreground text-lg">Total Collateral</h2>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-muted-foreground font-mono">{agentAddress}</span>
                        <button onClick={() => handleCopy("agent")} className="text-muted-foreground hover:text-foreground transition-colors">
                          {copiedAgent ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>
                  </div>
                  
                  <div>
                    <div className="text-5xl font-semibold tracking-tight text-foreground">
                      <span className="text-muted-foreground/60 mr-1">~</span>
                      <span className="text-muted-foreground/60 mr-1">$</span>8,640
                    </div>
                    <div className="text-sm font-medium text-muted-foreground mt-2">
                      Backing your automated trading across 5 assets
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-4 pt-4">
                     <Badge className="bg-primary/20 text-primary hover:bg-primary/30 border-0 font-medium">Trading Active</Badge>
                     <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <span className="w-2 h-2 rounded-full bg-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.6)]" />
                      <span>Gas: 0.18 SOL</span>
                     </div>
                  </div>
                </div>

                {/* The Basket */}
                <div className="flex-1 w-full bg-black/20 rounded-2xl border border-white/5 p-6">
                  <h3 className="text-sm font-medium text-muted-foreground mb-4">Collateral Basket</h3>
                  <div className="space-y-4">
                    {collateralAssets.map((asset, i) => (
                      <div key={asset.ticker} className="flex items-center justify-between group">
                        <div className="flex items-center gap-3">
                          {asset.icon}
                          <div>
                            <div className="font-medium text-foreground text-sm flex items-center gap-2">
                              {asset.name}
                              <span className="text-xs text-muted-foreground">{asset.ticker}</span>
                            </div>
                            <div className="text-xs text-muted-foreground mt-0.5">{asset.amount} held</div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-medium text-sm">{asset.value}</div>
                          <div className="flex items-center gap-2 mt-1.5 justify-end">
                            <span className="text-xs text-muted-foreground tabular-nums">{asset.weight}%</span>
                            <div className="w-16 h-1.5 bg-white/5 rounded-full overflow-hidden">
                              <div className="h-full bg-primary/60 rounded-full" style={{ width: `${asset.weight}%` }} />
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

              </div>
            </CardContent>
          </Card>
        </motion.div>

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
                <div className="border-b border-border/50 px-6 py-4 bg-muted/20 overflow-x-auto scrollbar-hide">
                  <TabsList className="bg-transparent space-x-6 p-0 h-auto">
                    <TabsTrigger 
                      value="deposit" 
                      className="px-0 py-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:text-primary rounded-none border-b-2 border-transparent data-[state=active]:border-primary text-base font-medium text-muted-foreground hover:text-foreground transition-all"
                    >
                      Deposit
                    </TabsTrigger>
                    <TabsTrigger 
                      value="borrow" 
                      className="px-0 py-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:text-primary rounded-none border-b-2 border-transparent data-[state=active]:border-primary text-base font-medium text-muted-foreground hover:text-foreground transition-all"
                    >
                      Borrow
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
                          <h3 className="text-xl font-semibold">Add Collateral</h3>
                          <p className="text-muted-foreground">Deposit any supported asset to increase your trading power. Held as-is.</p>
                        </div>

                        <div className="bg-muted/30 p-6 rounded-2xl border border-border/50 space-y-5">
                          <div className="flex justify-between items-center mb-2">
                            <Label className="text-sm font-medium text-muted-foreground">Asset & Amount</Label>
                            <span className="text-sm text-muted-foreground">Wallet Balance: 1,250.40 USDC</span>
                          </div>
                          <div className="flex gap-3">
                            <Select defaultValue="usdc">
                              <SelectTrigger className="w-[140px] h-14 bg-background border-border/50 rounded-xl text-lg">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="usdc">USDC</SelectItem>
                                <SelectItem value="sol">SOL</SelectItem>
                                <SelectItem value="wbtc">wBTC</SelectItem>
                                <SelectItem value="weth">wETH</SelectItem>
                                <SelectItem value="inf">INF</SelectItem>
                              </SelectContent>
                            </Select>
                            <div className="relative flex-1">
                              <Input 
                                type="text" 
                                placeholder="0.00" 
                                className="pl-4 pr-16 text-2xl h-14 bg-background border-border/50 rounded-xl w-full" 
                              />
                              <Button variant="ghost" className="absolute right-2 top-2 h-10 text-primary hover:text-primary hover:bg-primary/10">Max</Button>
                            </div>
                          </div>
                        </div>

                        <Button size="lg" className="w-full h-14 text-lg rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground shadow-glow">
                          <ArrowDownToLine className="w-5 h-5 mr-2" />
                          Deposit Collateral
                        </Button>

                        <div className="bg-accent/5 border border-accent/20 rounded-2xl p-4 flex items-start gap-4">
                          <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center shrink-0 mt-0.5">
                            <Sparkles className="w-4 h-4 text-accent" />
                          </div>
                          <div>
                            <h4 className="text-sm font-medium text-foreground mb-1">Got an unsupported token?</h4>
                            <p className="text-sm text-muted-foreground leading-relaxed mb-3">Deposit BONK or other tokens and we'll automatically swap them to USDC for your collateral.</p>
                            <Button variant="outline" size="sm" className="h-8 border-accent/30 text-accent hover:bg-accent/10">Auto-convert to USDC</Button>
                          </div>
                        </div>
                      </motion.div>
                    )}

                    {/* BORROW TAB */}
                    {activeTab === "borrow" && (
                      <motion.div
                        key="borrow"
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 10 }}
                        className="space-y-8"
                      >
                        <div className="space-y-2">
                          <h3 className="text-xl font-semibold">Borrow USDC</h3>
                          <p className="text-muted-foreground">Borrow USDC against your multi-asset basket without selling.</p>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                           <div className="bg-muted/30 p-5 rounded-xl border border-border/50">
                              <div className="text-sm text-muted-foreground mb-1">Available to borrow</div>
                              <div className="text-2xl font-semibold text-primary">~$3,800</div>
                           </div>
                           <div className="bg-muted/30 p-5 rounded-xl border border-border/50">
                              <div className="text-sm text-muted-foreground mb-1">Current borrowed</div>
                              <div className="text-2xl font-semibold text-foreground">$0.00</div>
                           </div>
                        </div>

                        <div className="bg-muted/30 p-6 rounded-2xl border border-border/50 space-y-5">
                          <div className="flex justify-between items-center mb-2">
                            <Label className="text-sm font-medium text-muted-foreground">Borrow Amount (USDC)</Label>
                            <span className="text-sm text-muted-foreground flex items-center gap-1"><Activity className="w-3.5 h-3.5"/> Health: Excellent</span>
                          </div>
                          <div className="relative flex items-center">
                            <span className="absolute left-4 text-xl text-muted-foreground">$</span>
                            <Input 
                              type="text" 
                              placeholder="0.00" 
                              className="pl-8 text-2xl h-14 bg-background border-border/50 rounded-xl" 
                            />
                            <Button variant="ghost" className="absolute right-2 h-10 text-primary hover:text-primary hover:bg-primary/10">Safe Max</Button>
                          </div>
                        </div>

                        <Button size="lg" className="w-full h-14 text-lg rounded-xl bg-card border border-primary/40 hover:bg-primary/10 text-primary">
                          Borrow USDC
                        </Button>
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
                          <p className="text-muted-foreground">Pull any collateral asset back to your personal wallet.</p>
                        </div>

                        <div className="bg-muted/30 p-6 rounded-2xl border border-border/50 space-y-5">
                          <div className="flex justify-between items-center mb-2">
                            <Label className="text-sm font-medium text-muted-foreground">Asset & Amount</Label>
                            <span className="text-sm text-muted-foreground">Available: 4,820.16 USDC</span>
                          </div>
                          <div className="flex gap-3">
                            <Select defaultValue="usdc">
                              <SelectTrigger className="w-[140px] h-14 bg-background border-border/50 rounded-xl text-lg">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="usdc">USDC</SelectItem>
                                <SelectItem value="sol">SOL</SelectItem>
                                <SelectItem value="wbtc">wBTC</SelectItem>
                                <SelectItem value="weth">wETH</SelectItem>
                                <SelectItem value="inf">INF</SelectItem>
                              </SelectContent>
                            </Select>
                            <div className="relative flex-1">
                              <Input 
                                type="text" 
                                placeholder="0.00" 
                                className="pl-4 pr-16 text-2xl h-14 bg-background border-border/50 rounded-xl w-full" 
                              />
                              <Button variant="ghost" className="absolute right-2 top-2 h-10 text-primary hover:text-primary hover:bg-primary/10">Max</Button>
                            </div>
                          </div>
                        </div>

                        <Button size="lg" className="w-full h-14 text-lg rounded-xl bg-card border border-border hover:bg-muted text-foreground">
                          <ArrowUpFromLine className="w-5 h-5 mr-2" />
                          Withdraw
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
                              <p className="text-muted-foreground mt-1">SOL is required to pay transaction fees on Solana. Keep your agent topped up.</p>
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
                              We automatically keep ~0.01 SOL in your wallet and ~0.005 SOL in your agent.
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

          {/* Right Column: Activity & Context */}
          <motion.div 
            className="space-y-6"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25 }}
          >
            {/* Wallet Context */}
            <Card className="bg-card/50 border-border/40 backdrop-blur-sm shadow-card">
              <CardContent className="p-6">
                 <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-xl bg-muted/50 flex items-center justify-center">
                      <Wallet className="w-5 h-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h2 className="font-medium text-foreground text-sm">Your Connected Wallet</h2>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground font-mono">{walletAddress}</span>
                        <button onClick={() => handleCopy("wallet")} className="text-muted-foreground hover:text-foreground transition-colors">
                          {copiedWallet ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-3">
                     <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">USDC Balance</span>
                        <span className="font-medium">1,250.40</span>
                     </div>
                     <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">SOL Balance</span>
                        <span className="font-medium">2.31</span>
                     </div>
                  </div>
              </CardContent>
            </Card>

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
                        <p className="text-sm font-medium">Deposited SOL Collateral</p>
                        <p className="text-xs text-muted-foreground">Today, 2:41 PM</p>
                      </div>
                    </div>
                    <span className="text-sm font-medium text-foreground">+14.2 SOL</span>
                  </div>
                  
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center">
                        <ArrowDownUp className="w-4 h-4 text-accent" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">Borrowed USDC</p>
                        <p className="text-xs text-muted-foreground">Yesterday</p>
                      </div>
                    </div>
                    <span className="text-sm font-medium text-foreground">+$800.00</span>
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
                        <p className="text-xs text-muted-foreground">Pull everything to wallet</p>
                      </div>
                    </div>
                  </button>
                  <button className="w-full flex items-center justify-between rounded-lg px-3 py-2.5 text-left group hover:bg-muted/40 transition-colors">
                    <div className="flex items-center gap-3">
                      <KeyRound className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
                      <div>
                        <p className="text-sm text-foreground">Reveal recovery phrase</p>
                        <p className="text-xs text-muted-foreground">Agent private key</p>
                      </div>
                    </div>
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

export default MoneyHub;
