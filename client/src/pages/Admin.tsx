import { safeResponseJson } from "@/lib/safe-fetch";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Lock, Activity, Bot, Users, Webhook, TrendingUp, ArrowLeft, RefreshCw, Clock, CheckCircle, XCircle, AlertTriangle, Rocket, ExternalLink, Send, Eye, Copy, FlaskConical, Power, UserCheck, DollarSign } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

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
  const [showRestartDialog, setShowRestartDialog] = useState(false);
  const { toast } = useToast();

  const authHeaders = {
    'Authorization': `Bearer ${sessionStorage.getItem('admin_token') || password}`,
  };

  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = useQuery({
    queryKey: ['admin-stats'],
    queryFn: async () => {
      const res = await fetch('/api/admin/stats', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch');
      return safeResponseJson(res);
    },
    enabled: authenticated,
    refetchInterval: 30000,
  });

  const { data: webhookLogs, isLoading: webhooksLoading, refetch: refetchWebhooks } = useQuery({
    queryKey: ['admin-webhooks'],
    queryFn: async () => {
      const res = await fetch('/api/admin/webhook-logs?limit=100', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch');
      return safeResponseJson(res);
    },
    enabled: authenticated && activeTab === 'webhooks',
  });

  const { data: trades, isLoading: tradesLoading, refetch: refetchTrades } = useQuery({
    queryKey: ['admin-trades'],
    queryFn: async () => {
      const res = await fetch('/api/admin/trades?limit=100', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch');
      return safeResponseJson(res);
    },
    enabled: authenticated && activeTab === 'trades',
  });

  const { data: bots, isLoading: botsLoading, refetch: refetchBots } = useQuery({
    queryKey: ['admin-bots'],
    queryFn: async () => {
      const res = await fetch('/api/admin/bots', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch');
      return safeResponseJson(res);
    },
    enabled: authenticated && activeTab === 'bots',
  });

  const { data: subscriptions, isLoading: subsLoading, refetch: refetchSubs } = useQuery({
    queryKey: ['admin-subscriptions'],
    queryFn: async () => {
      const res = await fetch('/api/admin/subscriptions', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch');
      return safeResponseJson(res);
    },
    enabled: authenticated && activeTab === 'subscriptions',
  });

  const { data: publishedBots, isLoading: pubBotsLoading, refetch: refetchPubBots } = useQuery({
    queryKey: ['admin-published-bots'],
    queryFn: async () => {
      const res = await fetch('/api/admin/published-bots', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch');
      return safeResponseJson(res);
    },
    enabled: authenticated && activeTab === 'marketplace',
  });

  const { data: labStatus, refetch: refetchLabStatus } = useQuery({
    queryKey: ['admin-lab-status'],
    queryFn: async () => {
      const res = await fetch('/api/admin/lab/status', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch lab status');
      return safeResponseJson(res);
    },
    enabled: authenticated,
    refetchInterval: 5000,
  });

  const restartLabMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/admin/lab/restart', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
      });
      const data = await safeResponseJson(res);
      if (!res.ok) {
        throw new Error(data?.error || 'Restart failed');
      }
      return data;
    },
    onSuccess: (data: any) => {
      toast({
        title: 'QuantumLab restarted',
        description: `New PID: ${data?.newPid ?? 'unknown'}${typeof data?.pausedRuns === 'number' ? ` · Paused ${data.pausedRuns} run(s) for auto-resume` : ''}`,
      });
      refetchLabStatus();
    },
    onError: (err: any) => {
      toast({
        title: 'Restart failed',
        description: err?.message || 'Unknown error',
        variant: 'destructive' as any,
      });
    },
  });

  const { data: pendingShares, isLoading: sharesLoading, refetch: refetchShares } = useQuery({
    queryKey: ['admin-pending-shares'],
    queryFn: async () => {
      const res = await fetch('/api/admin/pending-profit-shares', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch');
      return safeResponseJson(res);
    },
    enabled: authenticated && activeTab === 'profit-shares',
  });

  const { data: users, isLoading: usersLoading, refetch: refetchUsers } = useQuery({
    queryKey: ['admin-users'],
    queryFn: async () => {
      const res = await fetch('/api/admin/users', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch');
      return safeResponseJson(res);
    },
    enabled: authenticated && activeTab === 'users',
  });

  const { data: revenue, isLoading: revenueLoading, refetch: refetchRevenue } = useQuery({
    queryKey: ['admin-revenue'],
    queryFn: async () => {
      const res = await fetch('/api/admin/revenue', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch');
      return safeResponseJson(res);
    },
    enabled: authenticated && activeTab === 'revenue',
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
      case 'users': refetchUsers(); break;
      case 'revenue': refetchRevenue(); break;
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

        <Card className="bg-zinc-900/80 border-zinc-800 mb-6">
          <CardHeader className="pb-3">
            <CardTitle className="text-white flex items-center gap-2">
              <FlaskConical className="w-5 h-5 text-violet-400" />
              QuantumLab
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div className="space-y-1 text-sm" data-testid="status-lab-supervisor">
                <div className="flex items-center gap-2">
                  <span className="text-zinc-400">Status:</span>
                  {labStatus?.restartInFlight ? (
                    <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">
                      <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> Restarting
                    </Badge>
                  ) : labStatus?.suspended ? (
                    <Badge className="bg-red-500/20 text-red-400 border-red-500/30">
                      <AlertTriangle className="w-3 h-3 mr-1" /> Suspended (cooldown)
                    </Badge>
                  ) : labStatus?.isReady ? (
                    <Badge className="bg-green-500/20 text-green-400 border-green-500/30">
                      <CheckCircle className="w-3 h-3 mr-1" /> Running
                    </Badge>
                  ) : (
                    <Badge className="bg-red-500/20 text-red-400 border-red-500/30">
                      <XCircle className="w-3 h-3 mr-1" /> Unhealthy
                    </Badge>
                  )}
                </div>
                <div className="text-zinc-500 text-xs font-mono">
                  PID: {labStatus?.pid ?? '—'} · Port: {labStatus?.labPort ?? '—'} · Restarts: {labStatus?.restartCount ?? 0} · Failures: {labStatus?.consecutiveFailures ?? 0}
                </div>
              </div>
              <Button
                variant="outline"
                className="border-red-700 text-red-400 hover:bg-red-500/10"
                onClick={() => setShowRestartDialog(true)}
                disabled={restartLabMutation.isPending || labStatus?.restartInFlight}
                data-testid="button-restart-lab"
              >
                <Power className="w-4 h-4 mr-2" />
                {restartLabMutation.isPending || labStatus?.restartInFlight ? 'Restarting…' : 'Restart Lab'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <AlertDialog open={showRestartDialog} onOpenChange={setShowRestartDialog}>
          <AlertDialogContent className="bg-zinc-900 border-zinc-800" data-testid="dialog-restart-lab-confirm">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-white">Restart QuantumLab?</AlertDialogTitle>
              <AlertDialogDescription className="text-zinc-400">
                This will restart the backtesting engine for ALL users. Any in-flight runs across the platform will be paused and resumed automatically from their last checkpoint. Trading, webhooks, and other services are not affected.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-red-600 hover:bg-red-500 text-white"
                onClick={() => {
                  setShowRestartDialog(false);
                  restartLabMutation.mutate();
                }}
                data-testid="button-confirm-restart-lab"
              >
                Restart
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="bg-zinc-800/50 border border-zinc-700 p-1">
            <TabsTrigger value="stats" className="data-[state=active]:bg-violet-600"><Activity className="w-4 h-4 mr-2" />Stats</TabsTrigger>
            <TabsTrigger value="webhooks" className="data-[state=active]:bg-violet-600"><Webhook className="w-4 h-4 mr-2" />Webhooks</TabsTrigger>
            <TabsTrigger value="trades" className="data-[state=active]:bg-violet-600"><TrendingUp className="w-4 h-4 mr-2" />Trades</TabsTrigger>
            <TabsTrigger value="bots" className="data-[state=active]:bg-violet-600"><Bot className="w-4 h-4 mr-2" />Bots</TabsTrigger>
            <TabsTrigger value="subscriptions" className="data-[state=active]:bg-violet-600"><Users className="w-4 h-4 mr-2" />Subscriptions</TabsTrigger>
            <TabsTrigger value="marketplace" className="data-[state=active]:bg-violet-600">Marketplace</TabsTrigger>
            <TabsTrigger value="profit-shares" className="data-[state=active]:bg-violet-600">Profit Shares</TabsTrigger>
            <TabsTrigger value="users" className="data-[state=active]:bg-violet-600"><UserCheck className="w-4 h-4 mr-2" />Users</TabsTrigger>
            <TabsTrigger value="revenue" className="data-[state=active]:bg-violet-600"><DollarSign className="w-4 h-4 mr-2" />Revenue</TabsTrigger>
            <TabsTrigger value="superteam" className="data-[state=active]:bg-emerald-600"><Rocket className="w-4 h-4 mr-2" />Grants</TabsTrigger>
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

          <TabsContent value="users">
            <Card className="bg-zinc-900/80 border-zinc-800">
              <CardHeader>
                <CardTitle className="text-white flex items-center gap-2">
                  <UserCheck className="w-5 h-5 text-violet-400" />
                  Users ({users?.length || 0})
                </CardTitle>
                <p className="text-xs text-zinc-500 mt-1">
                  Signup → wallet → on-chain account funnel. Wallet pubkey is the user identity (no separate username system). PDA = wallet-level Pacifica subaccount.
                </p>
              </CardHeader>
              <CardContent>
                {usersLoading ? (
                  <div className="text-center py-8 text-zinc-400">Loading...</div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-zinc-700">
                          <TableHead className="text-zinc-400">Wallet</TableHead>
                          <TableHead className="text-zinc-400">Username</TableHead>
                          <TableHead className="text-zinc-400">PDA</TableHead>
                          <TableHead className="text-zinc-400 text-center">Bots</TableHead>
                          <TableHead className="text-zinc-400 text-center">Builder</TableHead>
                          <TableHead className="text-zinc-400 text-center">Referral</TableHead>
                          <TableHead className="text-zinc-400 text-center">Exec</TableHead>
                          <TableHead className="text-zinc-400 text-center">TG</TableHead>
                          <TableHead className="text-zinc-400">Created</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {users?.map((u: any) => (
                          <TableRow key={u.address} className="border-zinc-800" data-testid={`row-user-${u.address}`}>
                            <TableCell className="text-zinc-300 font-mono text-xs">
                              <div className="flex items-center gap-1">
                                <span>{truncateAddress(u.address)}</span>
                                <button
                                  onClick={() => navigator.clipboard.writeText(u.address)}
                                  className="text-zinc-500 hover:text-zinc-300"
                                  title={u.address}
                                >
                                  <Copy className="w-3 h-3" />
                                </button>
                              </div>
                            </TableCell>
                            <TableCell className="text-zinc-300 text-xs">
                              {u.displayName || (u.xUsername ? `@${u.xUsername}` : <span className="text-zinc-600">—</span>)}
                            </TableCell>
                            <TableCell className="text-zinc-300 font-mono text-xs">
                              {u.protocolSubaccountId
                                ? <span title={u.protocolSubaccountId}>{truncateAddress(u.protocolSubaccountId)}</span>
                                : <span className="text-zinc-600">—</span>}
                            </TableCell>
                            <TableCell className="text-center text-zinc-300 text-xs">
                              {u.activeBotCount}/{u.botCount}
                            </TableCell>
                            <TableCell className="text-center">
                              {u.pacificaBuilderApproved
                                ? <CheckCircle className="w-4 h-4 text-green-400 inline" />
                                : <XCircle className="w-4 h-4 text-zinc-600 inline" />}
                            </TableCell>
                            <TableCell className="text-center">
                              {u.pacificaReferralClaimed
                                ? <CheckCircle className="w-4 h-4 text-green-400 inline" />
                                : <XCircle className="w-4 h-4 text-zinc-600 inline" />}
                            </TableCell>
                            <TableCell className="text-center">
                              {u.executionEnabled
                                ? <CheckCircle className="w-4 h-4 text-green-400 inline" />
                                : <XCircle className="w-4 h-4 text-zinc-600 inline" />}
                            </TableCell>
                            <TableCell className="text-center">
                              {u.telegramConnected
                                ? <CheckCircle className="w-4 h-4 text-green-400 inline" />
                                : <XCircle className="w-4 h-4 text-zinc-600 inline" />}
                            </TableCell>
                            <TableCell className="text-zinc-400 text-xs">{formatDate(u.createdAt)}</TableCell>
                          </TableRow>
                        ))}
                        {(!users || users.length === 0) && (
                          <TableRow>
                            <TableCell colSpan={9} className="text-center text-zinc-500 py-8">No users found</TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="revenue" className="space-y-4">
            {revenueLoading ? (
              <div className="text-center py-12 text-zinc-400">Loading revenue...</div>
            ) : revenue ? (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Card className="bg-zinc-900/80 border-zinc-800">
                    <CardHeader>
                      <CardTitle className="text-white flex items-center gap-2">
                        <Users className="w-5 h-5 text-violet-400" />
                        Referral Revenue (paid out to referrers)
                      </CardTitle>
                      <p className="text-xs text-zinc-500 mt-1">
                        Authoritative — sourced from the referral_reward_events ledger.
                      </p>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-3 gap-3 mb-4">
                        <div>
                          <div className="text-xs text-zinc-500">Paid</div>
                          <div className="text-2xl font-semibold text-green-400" data-testid="text-referral-paid">
                            ${revenue.referral.paidUsdc.toFixed(2)}
                          </div>
                          <div className="text-xs text-zinc-500">{revenue.referral.paidCount} events</div>
                        </div>
                        <div>
                          <div className="text-xs text-zinc-500">Pending</div>
                          <div className="text-2xl font-semibold text-yellow-400" data-testid="text-referral-pending">
                            ${revenue.referral.pendingUsdc.toFixed(2)}
                          </div>
                          <div className="text-xs text-zinc-500">{revenue.referral.pendingCount} events</div>
                        </div>
                        <div>
                          <div className="text-xs text-zinc-500">Failed</div>
                          <div className="text-2xl font-semibold text-red-400" data-testid="text-referral-failed">
                            ${revenue.referral.failedUsdc.toFixed(2)}
                          </div>
                          <div className="text-xs text-zinc-500">{revenue.referral.failedCount} events</div>
                        </div>
                      </div>
                      {revenue.referral.topEarners.length > 0 && (
                        <div className="mt-4">
                          <div className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Top earners</div>
                          <Table>
                            <TableHeader>
                              <TableRow className="border-zinc-700">
                                <TableHead className="text-zinc-400">Wallet</TableHead>
                                <TableHead className="text-zinc-400 text-right">Paid</TableHead>
                                <TableHead className="text-zinc-400 text-right">Pending</TableHead>
                                <TableHead className="text-zinc-400 text-right">Events</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {revenue.referral.topEarners.map((e: any) => (
                                <TableRow key={e.earnerWallet} className="border-zinc-800">
                                  <TableCell className="text-zinc-300 font-mono text-xs">{truncateAddress(e.earnerWallet)}</TableCell>
                                  <TableCell className="text-right text-green-400 text-xs">${e.paidUsdc.toFixed(2)}</TableCell>
                                  <TableCell className="text-right text-yellow-400 text-xs">${e.pendingUsdc.toFixed(2)}</TableCell>
                                  <TableCell className="text-right text-zinc-400 text-xs">{e.eventCount}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card className="bg-zinc-900/80 border-zinc-800">
                    <CardHeader>
                      <CardTitle className="text-white flex items-center gap-2">
                        <DollarSign className="w-5 h-5 text-violet-400" />
                        Builder Code Revenue (our cut)
                      </CardTitle>
                      <p className="text-xs text-amber-400/80 mt-1">
                        Estimated ceiling — not authoritative.
                      </p>
                    </CardHeader>
                    <CardContent>
                      <div className="mb-4">
                        <div className="text-xs text-zinc-500">Estimated USDC</div>
                        <div className="text-3xl font-semibold text-violet-300" data-testid="text-builder-estimated">
                          ${revenue.builder.estimatedUsdc.toFixed(2)}
                        </div>
                        <div className="text-xs text-zinc-500 mt-1">
                          ${revenue.builder.filledNotional.toFixed(0)} notional × {(revenue.builder.feeRateCeiling * 100).toFixed(2)}% ceiling
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div>
                          <div className="text-xs text-zinc-500">Fills counted</div>
                          <div className="text-zinc-300 font-medium">{revenue.builder.fillCount}</div>
                        </div>
                        <div>
                          <div className="text-xs text-zinc-500">Approved wallets</div>
                          <div className="text-zinc-300 font-medium">{revenue.builder.approvedWallets}</div>
                        </div>
                      </div>
                      <div className="mt-4 p-3 rounded bg-amber-500/10 border border-amber-500/20 text-xs text-amber-200/90">
                        {revenue.builder.note}
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <Card className="bg-zinc-900/80 border-zinc-800">
                  <CardHeader>
                    <CardTitle className="text-white text-sm">Enrollment</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <div className="text-xs text-zinc-500">Builder-approved wallets</div>
                        <div className="text-2xl font-semibold text-zinc-200">{revenue.enrollment.builderApprovedWallets}</div>
                      </div>
                      <div>
                        <div className="text-xs text-zinc-500">Referral-claimed wallets</div>
                        <div className="text-2xl font-semibold text-zinc-200">{revenue.enrollment.referralClaimedWallets}</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </>
            ) : (
              <div className="text-center py-12 text-red-400">Failed to load revenue</div>
            )}
          </TabsContent>

          <TabsContent value="superteam">
            <SuperteamPanel authHeaders={authHeaders} />
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

function SuperteamPanel({ authHeaders }: { authHeaders: Record<string, string> }) {
  const queryClient = useQueryClient();
  const [agentName, setAgentName] = useState('quantumvault-agent');
  const [submitForm, setSubmitForm] = useState({
    link: 'https://myquantumvault.com',
    otherInfo: 'QuantumVault is a Solana-based perpetual futures trading platform. It enables automated bot trading via TradingView webhooks with optimized execution. Features include real-time PnL tracking, a signal marketplace with creator profit sharing, agent wallet architecture, and Phantom Wallet integration. Built with a decade of trading experience and 5+ years in Solana DeFi.',
    tweet: '',
    telegram: '@Kynomatix',
  });
  const [selectedListing, setSelectedListing] = useState<any>(null);
  const [viewingDetails, setViewingDetails] = useState<string | null>(null);

  const { data: agentData, isLoading: agentLoading } = useQuery({
    queryKey: ['superteam-agent'],
    queryFn: async () => {
      const res = await fetch('/api/admin/superteam/agent', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch');
      return safeResponseJson(res);
    },
  });

  const { data: listingsData, isLoading: listingsLoading, refetch: refetchListings } = useQuery({
    queryKey: ['superteam-listings'],
    queryFn: async () => {
      const res = await fetch('/api/admin/superteam/listings?take=100', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch');
      return safeResponseJson(res);
    },
    enabled: !!agentData?.agent,
  });

  const { data: submissionsData, refetch: refetchSubmissions } = useQuery({
    queryKey: ['superteam-submissions'],
    queryFn: async () => {
      const res = await fetch('/api/admin/superteam/submissions', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch');
      return safeResponseJson(res);
    },
    enabled: !!agentData?.agent,
  });

  const registerMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch('/api/admin/superteam/register', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const err = await safeResponseJson(res);
        throw new Error(err.error || 'Registration failed');
      }
      return safeResponseJson(res);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['superteam-agent'] });
    },
  });

  const fetchDetailsMutation = useMutation({
    mutationFn: async (slug: string) => {
      const res = await fetch(`/api/admin/superteam/listings/${slug}`, { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to fetch details');
      return safeResponseJson(res);
    },
    onSuccess: (data) => {
      setSelectedListing(data.listing);
    },
  });

  const submitMutation = useMutation({
    mutationFn: async (params: any) => {
      const res = await fetch('/api/admin/superteam/submit', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const err = await safeResponseJson(res);
        throw new Error(err.error || 'Submission failed');
      }
      return safeResponseJson(res);
    },
    onSuccess: () => {
      refetchSubmissions();
      setSelectedListing(null);
    },
  });

  const [editingSubmission, setEditingSubmission] = useState<any>(null);
  const [editForm, setEditForm] = useState({ link: '', otherInfo: '', tweet: '', telegram: '' });

  const updateMutation = useMutation({
    mutationFn: async (params: any) => {
      const res = await fetch('/api/admin/superteam/update-submission', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const err = await safeResponseJson(res);
        throw new Error(err.error || 'Update failed');
      }
      return safeResponseJson(res);
    },
    onSuccess: () => {
      refetchSubmissions();
      setEditingSubmission(null);
    },
  });

  const agent = agentData?.agent;
  const listings = listingsData?.listings || [];
  const submissions = submissionsData?.submissions || [];

  const { activeListings, expiredListings } = (() => {
    const now = Date.now();
    const active: any[] = [];
    const expired: any[] = [];
    for (const listing of listings) {
      const deadlineMs = listing.deadline ? new Date(listing.deadline).getTime() : NaN;
      if (Number.isFinite(deadlineMs) && deadlineMs < now) {
        expired.push(listing);
      } else {
        active.push(listing);
      }
    }
    const byDeadlineDesc = (a: any, b: any) => {
      const aMs = a.deadline ? new Date(a.deadline).getTime() : 0;
      const bMs = b.deadline ? new Date(b.deadline).getTime() : 0;
      return bMs - aMs;
    };
    active.sort(byDeadlineDesc);
    expired.sort(byDeadlineDesc);
    return { activeListings: active, expiredListings: expired };
  })();
  const sortedListings = [...activeListings, ...expiredListings];

  return (
    <div className="space-y-6">
      <Card className="bg-zinc-900/80 border-zinc-800">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <Rocket className="w-5 h-5 text-emerald-400" />
            Superteam Earn Agent
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {agentLoading ? (
            <div className="text-center py-8 text-zinc-400">Loading agent status...</div>
          ) : agent ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                  <CheckCircle className="w-3 h-3 mr-1" /> Registered
                </Badge>
                <span className="text-zinc-300 text-sm">{agent.agentName}</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4 bg-zinc-800/50 rounded-lg">
                <div>
                  <p className="text-zinc-500 text-xs mb-1">Agent ID</p>
                  <p className="text-zinc-300 text-sm font-mono">{agent.agentId}</p>
                </div>
                <div>
                  <p className="text-zinc-500 text-xs mb-1">Username</p>
                  <p className="text-zinc-300 text-sm">{agent.username}</p>
                </div>
                <div>
                  <p className="text-zinc-500 text-xs mb-1">Claim Code</p>
                  <div className="flex items-center gap-2">
                    <p className="text-emerald-400 text-sm font-mono font-bold">{agent.claimCode}</p>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-zinc-400 hover:text-white"
                      onClick={() => navigator.clipboard.writeText(agent.claimCode)}
                      data-testid="button-copy-claim-code"
                    >
                      <Copy className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              </div>
              <p className="text-zinc-500 text-xs">
                Claim URL: <a href={`https://superteam.fun/earn/claim/${agent.claimCode}`} target="_blank" rel="noopener" className="text-emerald-400 hover:underline">
                  superteam.fun/earn/claim/{agent.claimCode}
                </a>
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-zinc-400 text-sm">Register an agent identity to access agent-only grant listings on Superteam Earn.</p>
              <div className="flex items-center gap-3">
                <Input
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder="Agent name"
                  className="bg-zinc-800 border-zinc-700 text-white max-w-xs"
                  data-testid="input-agent-name"
                />
                <Button
                  onClick={() => registerMutation.mutate(agentName)}
                  disabled={registerMutation.isPending || !agentName.trim()}
                  className="bg-emerald-600 hover:bg-emerald-500"
                  data-testid="button-register-agent"
                >
                  {registerMutation.isPending ? 'Registering...' : 'Register Agent'}
                </Button>
              </div>
              {registerMutation.isError && (
                <p className="text-red-400 text-sm">{(registerMutation.error as Error).message}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {agent && (
        <>
          <Card className="bg-zinc-900/80 border-zinc-800">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-white flex items-center gap-2">
                <Eye className="w-5 h-5 text-blue-400" />
                Agent-Eligible Listings ({activeListings.length} active{expiredListings.length > 0 ? ` · ${expiredListings.length} expired` : ''})
              </CardTitle>
              <Button variant="outline" size="sm" onClick={() => refetchListings()} className="border-zinc-700 text-zinc-300">
                <RefreshCw className="w-4 h-4" />
              </Button>
            </CardHeader>
            <CardContent>
              {listingsLoading ? (
                <div className="text-center py-8 text-zinc-400">Loading listings...</div>
              ) : listings.length > 0 ? (
                <div className="space-y-3">
                  {sortedListings.map((listing: any) => {
                    const isExpired = expiredListings.includes(listing);
                    return (
                    <div
                      key={listing.id || listing.slug}
                      className={`p-4 bg-zinc-800/50 rounded-lg border border-zinc-700/50 hover:border-zinc-600 transition-colors ${isExpired ? 'opacity-50' : ''}`}
                      data-testid={`row-listing-${listing.slug}`}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h4 className={`font-medium text-sm truncate ${isExpired ? 'text-zinc-400' : 'text-white'}`}>{listing.title}</h4>
                            {isExpired && (
                              <Badge className="bg-zinc-700/60 text-zinc-300 border-zinc-600/50 text-[10px] px-1.5 py-0" data-testid={`badge-expired-${listing.slug}`}>
                                Expired
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-1">
                            <span className="text-zinc-400 text-xs">{listing.type || 'Bounty'}</span>
                            {listing.rewardAmount && <span className={`text-xs font-medium ${isExpired ? 'text-zinc-400' : 'text-emerald-400'}`}>{listing.rewardAmount} {listing.token || 'USDC'}</span>}
                            {listing.deadline && <span className="text-zinc-500 text-xs">Due: {formatDate(listing.deadline)}</span>}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-zinc-700 text-zinc-300 text-xs"
                            onClick={() => {
                              setViewingDetails(listing.slug);
                              fetchDetailsMutation.mutate(listing.slug);
                            }}
                            disabled={isExpired || (fetchDetailsMutation.isPending && viewingDetails === listing.slug)}
                            data-testid={`button-view-listing-${listing.slug}`}
                          >
                            <Eye className="w-3 h-3 mr-1" />
                            {fetchDetailsMutation.isPending && viewingDetails === listing.slug ? 'Loading...' : 'View & Submit'}
                          </Button>
                          {listing.slug && (
                            <a href={`https://superteam.fun/earn/listing/${listing.slug}`} target="_blank" rel="noopener">
                              <Button variant="ghost" size="sm" className="text-zinc-400 hover:text-white h-8 w-8 p-0">
                                <ExternalLink className="w-3 h-3" />
                              </Button>
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-8 text-zinc-500">No agent-eligible listings found</div>
              )}
            </CardContent>
          </Card>

          {selectedListing && (
            <Card className="bg-zinc-900/80 border-emerald-800/50 border-2">
              <CardHeader>
                <CardTitle className="text-white flex items-center gap-2">
                  <Send className="w-5 h-5 text-emerald-400" />
                  Submit to: {selectedListing.title}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {selectedListing.description && (
                  <div className="p-3 bg-zinc-800/50 rounded-lg max-h-48 overflow-y-auto">
                    <p className="text-zinc-400 text-sm whitespace-pre-wrap">{selectedListing.description}</p>
                  </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                  <div className="p-2 bg-zinc-800/30 rounded">
                    <span className="text-zinc-500">Reward:</span>{' '}
                    <span className="text-emerald-400 font-medium">{selectedListing.rewardAmount || selectedListing.usdValue} {selectedListing.token || 'USDG'}</span>
                  </div>
                  <div className="p-2 bg-zinc-800/30 rounded">
                    <span className="text-zinc-500">Type:</span>{' '}
                    <span className="text-zinc-300">{selectedListing.type}</span>
                  </div>
                  <div className="p-2 bg-zinc-800/30 rounded">
                    <span className="text-zinc-500">Deadline:</span>{' '}
                    <span className="text-zinc-300">{selectedListing.deadline ? formatDate(selectedListing.deadline) : 'N/A'}</span>
                  </div>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="text-zinc-400 text-sm mb-1 block">Project Link</label>
                    <Input
                      value={submitForm.link}
                      onChange={(e) => setSubmitForm(f => ({ ...f, link: e.target.value }))}
                      placeholder="https://your-project.com"
                      className="bg-zinc-800 border-zinc-700 text-white"
                      data-testid="input-submit-link"
                    />
                  </div>
                  <div>
                    <label className="text-zinc-400 text-sm mb-1 block">Description (what you built, how Solana is used, agent autonomy)</label>
                    <Textarea
                      value={submitForm.otherInfo}
                      onChange={(e) => setSubmitForm(f => ({ ...f, otherInfo: e.target.value }))}
                      placeholder="Describe your project, how it uses Solana meaningfully, and how the AI agent operated autonomously..."
                      className="bg-zinc-800 border-zinc-700 text-white min-h-[120px]"
                      data-testid="input-submit-description"
                    />
                  </div>
                  <div>
                    <label className="text-zinc-400 text-sm mb-1 block">Telegram (optional, for project listings)</label>
                    <Input
                      value={submitForm.telegram}
                      onChange={(e) => setSubmitForm(f => ({ ...f, telegram: e.target.value }))}
                      placeholder="http://t.me/your_username"
                      className="bg-zinc-800 border-zinc-700 text-white"
                      data-testid="input-submit-telegram"
                    />
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-2">
                  <Button
                    onClick={() => submitMutation.mutate({
                      listingId: selectedListing.id,
                      listingSlug: selectedListing.slug,
                      listingTitle: selectedListing.title,
                      link: submitForm.link,
                      otherInfo: submitForm.otherInfo,
                      tweet: submitForm.tweet,
                      telegram: submitForm.telegram,
                    })}
                    disabled={submitMutation.isPending || !submitForm.link || !submitForm.otherInfo}
                    className="bg-emerald-600 hover:bg-emerald-500"
                    data-testid="button-submit-listing"
                  >
                    {submitMutation.isPending ? 'Submitting...' : 'Submit Entry'}
                    <Send className="w-4 h-4 ml-2" />
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setSelectedListing(null)}
                    className="border-zinc-700 text-zinc-300"
                  >
                    Cancel
                  </Button>
                </div>
                {submitMutation.isError && (
                  <p className="text-red-400 text-sm">{(submitMutation.error as Error).message}</p>
                )}
                {submitMutation.isSuccess && (
                  <p className="text-emerald-400 text-sm">Submission sent successfully!</p>
                )}
              </CardContent>
            </Card>
          )}

          {submissions.length > 0 && (
            <Card className="bg-zinc-900/80 border-zinc-800">
              <CardHeader>
                <CardTitle className="text-white text-sm">Submission History ({submissions.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-zinc-700">
                        <TableHead className="text-zinc-400">Listing</TableHead>
                        <TableHead className="text-zinc-400">Link</TableHead>
                        <TableHead className="text-zinc-400">Status</TableHead>
                        <TableHead className="text-zinc-400">Submitted</TableHead>
                        <TableHead className="text-zinc-400">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {submissions.map((sub: any) => (
                        <TableRow key={sub.id} className="border-zinc-800">
                          <TableCell className="text-zinc-300 text-sm">{sub.listingTitle || sub.listingSlug || sub.listingId}</TableCell>
                          <TableCell>
                            <a href={sub.link} target="_blank" rel="noopener" className="text-emerald-400 hover:underline text-sm flex items-center gap-1">
                              {sub.link?.slice(0, 40)}... <ExternalLink className="w-3 h-3" />
                            </a>
                          </TableCell>
                          <TableCell><StatusBadge status={sub.status} /></TableCell>
                          <TableCell className="text-zinc-400 text-xs">{formatDate(sub.submittedAt)}</TableCell>
                          <TableCell>
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-zinc-600 text-zinc-300 hover:bg-zinc-700 text-xs"
                              onClick={() => {
                                setEditingSubmission(sub);
                                setEditForm({
                                  link: sub.link || '',
                                  otherInfo: sub.otherInfo || '',
                                  tweet: sub.tweet || '',
                                  telegram: sub.telegram || '',
                                });
                              }}
                              data-testid={`button-edit-submission-${sub.id}`}
                            >
                              Edit
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>

                  {editingSubmission && (
                    <div className="mt-4 p-4 bg-zinc-800/80 rounded-lg border border-emerald-600/30 space-y-3">
                      <h4 className="text-white text-sm font-medium">Editing: {editingSubmission.listingTitle || editingSubmission.listingSlug}</h4>
                      <div className="space-y-2">
                        <label className="text-zinc-400 text-sm mb-1 block">Link</label>
                        <Input
                          value={editForm.link}
                          onChange={(e) => setEditForm(f => ({ ...f, link: e.target.value }))}
                          className="bg-zinc-900 border-zinc-700 text-white text-sm"
                          data-testid="input-edit-link"
                        />
                        <label className="text-zinc-400 text-sm mb-1 block">Description</label>
                        <Textarea
                          value={editForm.otherInfo}
                          onChange={(e) => setEditForm(f => ({ ...f, otherInfo: e.target.value }))}
                          className="bg-zinc-900 border-zinc-700 text-white text-sm min-h-[80px]"
                          data-testid="input-edit-description"
                        />
                        <label className="text-zinc-400 text-sm mb-1 block">Telegram</label>
                        <Input
                          value={editForm.telegram}
                          onChange={(e) => setEditForm(f => ({ ...f, telegram: e.target.value }))}
                          className="bg-zinc-900 border-zinc-700 text-white text-sm"
                          data-testid="input-edit-telegram"
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
                          onClick={() => updateMutation.mutate({
                            listingId: editingSubmission.listingId,
                            link: editForm.link,
                            otherInfo: editForm.otherInfo,
                            tweet: editForm.tweet,
                            telegram: editForm.telegram,
                          })}
                          disabled={updateMutation.isPending || !editForm.link || !editForm.otherInfo}
                          data-testid="button-save-edit"
                        >
                          {updateMutation.isPending ? 'Updating...' : 'Save Changes'}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-zinc-600 text-zinc-300 hover:bg-zinc-700 text-xs"
                          onClick={() => setEditingSubmission(null)}
                          data-testid="button-cancel-edit"
                        >
                          Cancel
                        </Button>
                      </div>
                      {updateMutation.isError && (
                        <p className="text-red-400 text-sm">{(updateMutation.error as Error).message}</p>
                      )}
                      {updateMutation.isSuccess && (
                        <p className="text-emerald-400 text-sm">Submission updated successfully!</p>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

export default AdminPage;
