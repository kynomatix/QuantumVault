import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Lock, Activity, Bot, Users, Webhook, TrendingUp, ArrowLeft, RefreshCw, Clock, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const ADMIN_KEY = "admin_password";

function formatDate(dateString: string | null) {
  if (!dateString) return '-';
  return new Date(dateString).toLocaleString();
}

function truncateAddress(address: string | null | undefined) {
  if (!address) return '-';
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function StatusBadge({ status }: { status: string | boolean | null }) {
  if (status === true || status === 'active' || status === 'success' || status === 'completed') {
    return <Badge className="bg-green-500/20 text-green-400 border-green-500/30"><CheckCircle className="w-3 h-3 mr-1" /> Active</Badge>;
  }
  if (status === false || status === 'inactive' || status === 'failed' || status === 'cancelled') {
    return <Badge className="bg-red-500/20 text-red-400 border-red-500/30"><XCircle className="w-3 h-3 mr-1" /> Inactive</Badge>;
  }
  if (status === 'pending') {
    return <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30"><Clock className="w-3 h-3 mr-1" /> Pending</Badge>;
  }
  return <Badge variant="secondary">{String(status)}</Badge>;
}

function AdminPage() {
  const [password, setPassword] = useState('');
  const [authenticated, setAuthenticated] = useState(() => {
    return sessionStorage.getItem(ADMIN_KEY) === 'true';
  });
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('stats');

  const authHeaders = {
    'Authorization': `Bearer ${sessionStorage.getItem('admin_token') || password}`,
  };

  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = useQuery({
    queryKey: ['admin-stats'],
    queryFn: async () => {
      const res = await fetch('/api/admin/stats', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
    enabled: authenticated,
    refetchInterval: 30000,
  });

  const { data: webhookLogs, isLoading: webhooksLoading, refetch: refetchWebhooks } = useQuery({
    queryKey: ['admin-webhooks'],
    queryFn: async () => {
      const res = await fetch('/api/admin/webhook-logs?limit=100', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
    enabled: authenticated && activeTab === 'webhooks',
  });

  const { data: trades, isLoading: tradesLoading, refetch: refetchTrades } = useQuery({
    queryKey: ['admin-trades'],
    queryFn: async () => {
      const res = await fetch('/api/admin/trades?limit=100', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
    enabled: authenticated && activeTab === 'trades',
  });

  const { data: bots, isLoading: botsLoading, refetch: refetchBots } = useQuery({
    queryKey: ['admin-bots'],
    queryFn: async () => {
      const res = await fetch('/api/admin/bots', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
    enabled: authenticated && activeTab === 'bots',
  });

  const { data: subscriptions, isLoading: subsLoading, refetch: refetchSubs } = useQuery({
    queryKey: ['admin-subscriptions'],
    queryFn: async () => {
      const res = await fetch('/api/admin/subscriptions', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
    enabled: authenticated && activeTab === 'subscriptions',
  });

  const { data: publishedBots, isLoading: pubBotsLoading, refetch: refetchPubBots } = useQuery({
    queryKey: ['admin-published-bots'],
    queryFn: async () => {
      const res = await fetch('/api/admin/published-bots', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
    enabled: authenticated && activeTab === 'marketplace',
  });

  const { data: pendingShares, isLoading: sharesLoading, refetch: refetchShares } = useQuery({
    queryKey: ['admin-pending-shares'],
    queryFn: async () => {
      const res = await fetch('/api/admin/pending-profit-shares', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
    enabled: authenticated && activeTab === 'profit-shares',
  });

  const handleLogin = async () => {
    setError('');
    sessionStorage.removeItem(ADMIN_KEY);
    sessionStorage.removeItem('admin_token');
    
    try {
      const res = await fetch('/api/admin/stats', {
        headers: { 'Authorization': `Bearer ${password.trim()}` }
      });
      if (res.ok) {
        sessionStorage.setItem(ADMIN_KEY, 'true');
        sessionStorage.setItem('admin_token', password.trim());
        setAuthenticated(true);
      } else {
        setError('Invalid password');
      }
    } catch {
      setError('Connection error');
    }
  };

  const handleLogout = () => {
    sessionStorage.removeItem(ADMIN_KEY);
    sessionStorage.removeItem('admin_token');
    setAuthenticated(false);
    setPassword('');
  };

  const handleRefresh = () => {
    switch (activeTab) {
      case 'stats': refetchStats(); break;
      case 'webhooks': refetchWebhooks(); break;
      case 'trades': refetchTrades(); break;
      case 'bots': refetchBots(); break;
      case 'subscriptions': refetchSubs(); break;
      case 'marketplace': refetchPubBots(); break;
      case 'profit-shares': refetchShares(); break;
    }
  };

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-zinc-900 via-zinc-900 to-black flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-sm"
        >
          <Card className="bg-zinc-900/80 border-zinc-800 backdrop-blur">
            <CardHeader className="text-center pb-2">
              <div className="mx-auto w-12 h-12 rounded-full bg-violet-500/20 flex items-center justify-center mb-4">
                <Lock className="w-6 h-6 text-violet-400" />
              </div>
              <CardTitle className="text-xl text-white">Admin Access</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input
                type="password"
                placeholder="Enter admin password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                className="bg-zinc-800 border-zinc-700 text-white"
                data-testid="input-admin-password"
              />
              {error && <p className="text-red-400 text-sm text-center">{error}</p>}
              <Button 
                onClick={handleLogin} 
                className="w-full bg-violet-600 hover:bg-violet-500"
                data-testid="button-admin-login"
              >
                Authenticate
              </Button>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-900 via-zinc-900 to-black">
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <Link href="/">
              <Button variant="ghost" size="sm" className="text-zinc-400 hover:text-white">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back
              </Button>
            </Link>
            <h1 className="text-2xl font-bold text-white">Admin Dashboard</h1>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-zinc-400 text-sm">
              {stats?.serverTime && `Server: ${formatDate(stats.serverTime)}`}
            </span>
            <Button variant="outline" size="sm" onClick={handleRefresh} className="border-zinc-700 text-zinc-300">
              <RefreshCw className="w-4 h-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={handleLogout} className="border-red-700 text-red-400 hover:bg-red-500/10" data-testid="button-admin-logout">
              Logout
            </Button>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="bg-zinc-800/50 border border-zinc-700 p-1">
            <TabsTrigger value="stats" className="data-[state=active]:bg-violet-600"><Activity className="w-4 h-4 mr-2" />Stats</TabsTrigger>
            <TabsTrigger value="webhooks" className="data-[state=active]:bg-violet-600"><Webhook className="w-4 h-4 mr-2" />Webhooks</TabsTrigger>
            <TabsTrigger value="trades" className="data-[state=active]:bg-violet-600"><TrendingUp className="w-4 h-4 mr-2" />Trades</TabsTrigger>
            <TabsTrigger value="bots" className="data-[state=active]:bg-violet-600"><Bot className="w-4 h-4 mr-2" />Bots</TabsTrigger>
            <TabsTrigger value="subscriptions" className="data-[state=active]:bg-violet-600"><Users className="w-4 h-4 mr-2" />Subscriptions</TabsTrigger>
            <TabsTrigger value="marketplace" className="data-[state=active]:bg-violet-600">Marketplace</TabsTrigger>
            <TabsTrigger value="profit-shares" className="data-[state=active]:bg-violet-600">Profit Shares</TabsTrigger>
          </TabsList>

          <TabsContent value="stats" className="space-y-4">
            {statsLoading ? (
              <div className="text-center py-12 text-zinc-400">Loading stats...</div>
            ) : stats ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard title="Total Users" value={stats.totalUsers} icon={Users} />
                <StatCard title="Total Bots" value={stats.totalBots} icon={Bot} />
                <StatCard title="Active Bots" value={stats.activeBots} icon={CheckCircle} color="green" />
                <StatCard title="Total Trades" value={stats.totalTrades} icon={TrendingUp} />
                <StatCard title="Total Webhooks" value={stats.totalWebhooks} icon={Webhook} />
                <StatCard title="Processed Webhooks" value={stats.processedWebhooks} icon={CheckCircle} color="green" />
                <StatCard title="Active Subscriptions" value={stats.activeSubscriptions} icon={Users} color="blue" />
                <StatCard title="Pending Profit Shares" value={stats.pendingProfitShares} icon={AlertTriangle} color={stats.pendingProfitShares > 0 ? "yellow" : "green"} />
              </div>
            ) : (
              <div className="text-center py-12 text-red-400">Failed to load stats</div>
            )}
          </TabsContent>

          <TabsContent value="webhooks">
            <Card className="bg-zinc-900/80 border-zinc-800">
              <CardHeader>
                <CardTitle className="text-white flex items-center gap-2">
                  <Webhook className="w-5 h-5 text-violet-400" />
                  Recent Webhook Logs ({webhookLogs?.length || 0})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {webhooksLoading ? (
                  <div className="text-center py-8 text-zinc-400">Loading...</div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-zinc-700">
                          <TableHead className="text-zinc-400">Time</TableHead>
                          <TableHead className="text-zinc-400">Bot ID</TableHead>
                          <TableHead className="text-zinc-400">Signal</TableHead>
                          <TableHead className="text-zinc-400">Market</TableHead>
                          <TableHead className="text-zinc-400">Processed</TableHead>
                          <TableHead className="text-zinc-400">Source</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {webhookLogs?.map((log: any) => (
                          <TableRow key={log.id} className="border-zinc-800">
                            <TableCell className="text-zinc-300 text-xs">{formatDate(log.receivedAt)}</TableCell>
                            <TableCell className="text-zinc-300 font-mono text-xs">{log.botId}</TableCell>
                            <TableCell>
                              <Badge className={log.signal === 'LONG' ? 'bg-green-500/20 text-green-400' : log.signal === 'SHORT' ? 'bg-red-500/20 text-red-400' : 'bg-yellow-500/20 text-yellow-400'}>
                                {log.signal}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-zinc-300">{log.market}</TableCell>
                            <TableCell><StatusBadge status={log.processed} /></TableCell>
                            <TableCell className="text-zinc-500 text-xs">{log.sourceIp || '-'}</TableCell>
                          </TableRow>
                        ))}
                        {(!webhookLogs || webhookLogs.length === 0) && (
                          <TableRow>
                            <TableCell colSpan={6} className="text-center text-zinc-500 py-8">No webhook logs found</TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="trades">
            <Card className="bg-zinc-900/80 border-zinc-800">
              <CardHeader>
                <CardTitle className="text-white flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-green-400" />
                  Recent Trades ({trades?.length || 0})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {tradesLoading ? (
                  <div className="text-center py-8 text-zinc-400">Loading...</div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-zinc-700">
                          <TableHead className="text-zinc-400">Time</TableHead>
                          <TableHead className="text-zinc-400">Bot ID</TableHead>
                          <TableHead className="text-zinc-400">Market</TableHead>
                          <TableHead className="text-zinc-400">Direction</TableHead>
                          <TableHead className="text-zinc-400">Size</TableHead>
                          <TableHead className="text-zinc-400">Price</TableHead>
                          <TableHead className="text-zinc-400">Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {trades?.map((trade: any) => (
                          <TableRow key={trade.id} className="border-zinc-800">
                            <TableCell className="text-zinc-300 text-xs">{formatDate(trade.executedAt)}</TableCell>
                            <TableCell className="text-zinc-300 font-mono text-xs">{trade.tradingBotId}</TableCell>
                            <TableCell className="text-zinc-300">{trade.market}</TableCell>
                            <TableCell>
                              <Badge className={trade.direction === 'long' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}>
                                {trade.direction?.toUpperCase()}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-zinc-300">{trade.size}</TableCell>
                            <TableCell className="text-zinc-300">${parseFloat(trade.entryPrice || 0).toFixed(2)}</TableCell>
                            <TableCell><StatusBadge status={trade.status} /></TableCell>
                          </TableRow>
                        ))}
                        {(!trades || trades.length === 0) && (
                          <TableRow>
                            <TableCell colSpan={7} className="text-center text-zinc-500 py-8">No trades found</TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="bots">
            <Card className="bg-zinc-900/80 border-zinc-800">
              <CardHeader>
                <CardTitle className="text-white flex items-center gap-2">
                  <Bot className="w-5 h-5 text-violet-400" />
                  All Bots ({bots?.length || 0})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {botsLoading ? (
                  <div className="text-center py-8 text-zinc-400">Loading...</div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-zinc-700">
                          <TableHead className="text-zinc-400">ID</TableHead>
                          <TableHead className="text-zinc-400">Name</TableHead>
                          <TableHead className="text-zinc-400">Wallet</TableHead>
                          <TableHead className="text-zinc-400">Market</TableHead>
                          <TableHead className="text-zinc-400">Max Size</TableHead>
                          <TableHead className="text-zinc-400">Leverage</TableHead>
                          <TableHead className="text-zinc-400">Status</TableHead>
                          <TableHead className="text-zinc-400">Created</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {bots?.map((bot: any) => (
                          <TableRow key={bot.id} className="border-zinc-800">
                            <TableCell className="text-zinc-300 font-mono text-xs">{bot.id}</TableCell>
                            <TableCell className="text-zinc-300">{bot.name}</TableCell>
                            <TableCell className="text-zinc-400 font-mono text-xs">{truncateAddress(bot.walletAddress)}</TableCell>
                            <TableCell className="text-zinc-300">{bot.market}</TableCell>
                            <TableCell className="text-zinc-300">${bot.maxPositionSize}</TableCell>
                            <TableCell className="text-zinc-300">{bot.leverage}x</TableCell>
                            <TableCell><StatusBadge status={bot.isActive} /></TableCell>
                            <TableCell className="text-zinc-400 text-xs">{formatDate(bot.createdAt)}</TableCell>
                          </TableRow>
                        ))}
                        {(!bots || bots.length === 0) && (
                          <TableRow>
                            <TableCell colSpan={8} className="text-center text-zinc-500 py-8">No bots found</TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="subscriptions">
            <Card className="bg-zinc-900/80 border-zinc-800">
              <CardHeader>
                <CardTitle className="text-white flex items-center gap-2">
                  <Users className="w-5 h-5 text-blue-400" />
                  All Subscriptions ({subscriptions?.length || 0})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {subsLoading ? (
                  <div className="text-center py-8 text-zinc-400">Loading...</div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-zinc-700">
                          <TableHead className="text-zinc-400">Subscriber Bot</TableHead>
                          <TableHead className="text-zinc-400">Signal Source</TableHead>
                          <TableHead className="text-zinc-400">Status</TableHead>
                          <TableHead className="text-zinc-400">Subscribed At</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {subscriptions?.map((sub: any, i: number) => (
                          <TableRow key={i} className="border-zinc-800">
                            <TableCell className="text-zinc-300">{sub.subscriberBot?.name || sub.subscription?.subscriberBotId}</TableCell>
                            <TableCell className="text-zinc-300">{sub.publishedBot?.displayName || sub.subscription?.publishedBotId}</TableCell>
                            <TableCell><StatusBadge status={sub.subscription?.status} /></TableCell>
                            <TableCell className="text-zinc-400 text-xs">{formatDate(sub.subscription?.subscribedAt)}</TableCell>
                          </TableRow>
                        ))}
                        {(!subscriptions || subscriptions.length === 0) && (
                          <TableRow>
                            <TableCell colSpan={4} className="text-center text-zinc-500 py-8">No subscriptions found</TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="marketplace">
            <Card className="bg-zinc-900/80 border-zinc-800">
              <CardHeader>
                <CardTitle className="text-white">Published Bots ({publishedBots?.length || 0})</CardTitle>
              </CardHeader>
              <CardContent>
                {pubBotsLoading ? (
                  <div className="text-center py-8 text-zinc-400">Loading...</div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-zinc-700">
                          <TableHead className="text-zinc-400">Name</TableHead>
                          <TableHead className="text-zinc-400">Source Bot</TableHead>
                          <TableHead className="text-zinc-400">Profit Share %</TableHead>
                          <TableHead className="text-zinc-400">Subscribers</TableHead>
                          <TableHead className="text-zinc-400">Published</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {publishedBots?.map((pb: any, i: number) => (
                          <TableRow key={i} className="border-zinc-800">
                            <TableCell className="text-zinc-300">{pb.publishedBot?.displayName}</TableCell>
                            <TableCell className="text-zinc-300">{pb.sourceBot?.name || pb.publishedBot?.tradingBotId}</TableCell>
                            <TableCell className="text-zinc-300">{pb.publishedBot?.profitSharePercent}%</TableCell>
                            <TableCell className="text-zinc-300">{pb.publishedBot?.subscriberCount || 0}</TableCell>
                            <TableCell className="text-zinc-400 text-xs">{formatDate(pb.publishedBot?.publishedAt)}</TableCell>
                          </TableRow>
                        ))}
                        {(!publishedBots || publishedBots.length === 0) && (
                          <TableRow>
                            <TableCell colSpan={5} className="text-center text-zinc-500 py-8">No published bots found</TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="profit-shares">
            <Card className="bg-zinc-900/80 border-zinc-800">
              <CardHeader>
                <CardTitle className="text-white flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5 text-yellow-400" />
                  Pending Profit Shares ({pendingShares?.length || 0})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {sharesLoading ? (
                  <div className="text-center py-8 text-zinc-400">Loading...</div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-zinc-700">
                          <TableHead className="text-zinc-400">ID</TableHead>
                          <TableHead className="text-zinc-400">Source Bot</TableHead>
                          <TableHead className="text-zinc-400">Subscriber</TableHead>
                          <TableHead className="text-zinc-400">Amount (USDC)</TableHead>
                          <TableHead className="text-zinc-400">Status</TableHead>
                          <TableHead className="text-zinc-400">Retries</TableHead>
                          <TableHead className="text-zinc-400">Created</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pendingShares?.map((share: any) => (
                          <TableRow key={share.id} className="border-zinc-800">
                            <TableCell className="text-zinc-300 font-mono text-xs">{share.id}</TableCell>
                            <TableCell className="text-zinc-300">{share.sourceBotId}</TableCell>
                            <TableCell className="text-zinc-300">{share.subscriberBotId}</TableCell>
                            <TableCell className="text-zinc-300">${parseFloat(share.amountUsdc || 0).toFixed(4)}</TableCell>
                            <TableCell><StatusBadge status={share.status} /></TableCell>
                            <TableCell className="text-zinc-300">{share.retryCount || 0}</TableCell>
                            <TableCell className="text-zinc-400 text-xs">{formatDate(share.createdAt)}</TableCell>
                          </TableRow>
                        ))}
                        {(!pendingShares || pendingShares.length === 0) && (
                          <TableRow>
                            <TableCell colSpan={7} className="text-center text-zinc-500 py-8">No pending profit shares</TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function StatCard({ title, value, icon: Icon, color = "violet" }: { title: string; value: number | string; icon: any; color?: string }) {
  const colorClasses = {
    violet: "text-violet-400 bg-violet-500/20",
    green: "text-green-400 bg-green-500/20",
    blue: "text-blue-400 bg-blue-500/20",
    yellow: "text-yellow-400 bg-yellow-500/20",
    red: "text-red-400 bg-red-500/20",
  };
  const colors = colorClasses[color as keyof typeof colorClasses] || colorClasses.violet;

  return (
    <Card className="bg-zinc-900/80 border-zinc-800">
      <CardContent className="pt-6">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${colors.split(' ')[1]}`}>
            <Icon className={`w-5 h-5 ${colors.split(' ')[0]}`} />
          </div>
          <div>
            <p className="text-zinc-400 text-sm">{title}</p>
            <p className="text-2xl font-bold text-white">{value}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default AdminPage;
