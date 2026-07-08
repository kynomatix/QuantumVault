import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { safeResponseJson } from '@/lib/safe-fetch';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, CheckCircle2, Trash2, Save } from 'lucide-react';

export interface LlmKeyMeta {
  hasKey: boolean;
  last4: string | null;
}

interface LlmKeyStatusRowProps {
  dark?: boolean;
  className?: string;
}

/** Shared OpenRouter key management row.
 *  Used in both QuantumLab AI Creator (dark=true) and CreateAiTraderModal (default).
 *  Both surfaces share the same `/api/lab/creator/key` store — one key, two entry points.
 */
export function LlmKeyStatusRow({ dark = false, className }: LlmKeyStatusRowProps) {
  const { toast } = useToast();
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [editingKey, setEditingKey] = useState(false);

  const { data: keyMeta, isLoading: keyLoading } = useQuery<LlmKeyMeta>({
    queryKey: ['/api/lab/creator/key'],
    queryFn: async () => {
      const res = await fetch('/api/lab/creator/key');
      if (!res.ok) return { hasKey: false, last4: null };
      return safeResponseJson(res);
    },
  });

  const hasKey = !!keyMeta?.hasKey;

  const saveKeyMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/lab/creator/key', { apiKey: apiKeyInput.trim() });
      return safeResponseJson(res);
    },
    onSuccess: () => {
      setApiKeyInput('');
      setEditingKey(false);
      queryClient.invalidateQueries({ queryKey: ['/api/lab/creator/key'] });
      toast({ title: 'API key saved', description: 'Your OpenRouter key is encrypted and stored only for you.' });
    },
    onError: (err: any) => {
      toast({ title: "Couldn't save key", description: err?.message ?? 'Unknown error', variant: 'destructive' });
    },
  });

  const clearKeyMutation = useMutation({
    mutationFn: async () => { await apiRequest('DELETE', '/api/lab/creator/key'); },
    onSuccess: () => {
      setEditingKey(false);
      setApiKeyInput('');
      queryClient.invalidateQueries({ queryKey: ['/api/lab/creator/key'] });
      toast({ title: 'API key removed' });
    },
    onError: (err: any) => {
      toast({ title: "Couldn't remove key", description: err?.message ?? 'Unknown error', variant: 'destructive' });
    },
  });

  if (keyLoading) {
    return (
      <div className={`flex items-center gap-2 text-sm ${dark ? 'text-white/50' : 'text-muted-foreground'} ${className ?? ''}`}>
        <Loader2 className="w-4 h-4 animate-spin" />
        Checking…
      </div>
    );
  }

  if (hasKey && !editingKey) {
    return (
      <div className={`space-y-2 ${className ?? ''}`}>
        <div className={`flex items-center gap-2 text-sm ${dark ? 'text-white/70' : 'text-muted-foreground'}`}>
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span>Key set</span>
          <code className={`px-1.5 py-0.5 rounded text-[12px] ${dark ? 'bg-black/40 text-white/60' : 'bg-muted'}`}>
            sk-or-…{keyMeta?.last4}
          </code>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setEditingKey(true)}
            data-testid="button-replace-key"
            className={dark ? 'bg-white/5 hover:bg-white/10 text-white/70' : ''}
          >
            Replace
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => clearKeyMutation.mutate()}
            disabled={clearKeyMutation.isPending}
            data-testid="button-clear-key"
            className={dark ? 'bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/20' : 'text-destructive hover:text-destructive border-destructive/30'}
          >
            {clearKeyMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Trash2 className="w-3 h-3 mr-1" />}
            Remove
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={`space-y-2 ${className ?? ''}`}>
      <p className={`text-[12px] ${dark ? 'text-white/50' : 'text-muted-foreground'}`}>
        AI decisions run on your own OpenRouter account so you control spend. Get a key at{' '}
        <a
          href="https://openrouter.ai/keys"
          target="_blank"
          rel="noopener noreferrer"
          className={dark ? 'text-indigo-400 hover:underline' : 'text-primary hover:underline'}
          data-testid="link-openrouter-keys"
        >
          openrouter.ai/keys
        </a>
        . Encrypted on our server, never shown again.
      </p>
      <Input
        type="password"
        value={apiKeyInput}
        onChange={(e) => setApiKeyInput(e.target.value)}
        placeholder="sk-or-v1-…"
        className={`font-mono text-sm ${dark ? 'bg-black/40 border-white/10 text-white' : ''}`}
        data-testid="input-api-key"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => saveKeyMutation.mutate()}
          disabled={saveKeyMutation.isPending || !apiKeyInput.trim()}
          data-testid="button-save-key"
          className={dark ? 'bg-indigo-600 hover:bg-indigo-500 text-white' : ''}
        >
          {saveKeyMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Save className="w-3 h-3 mr-1" />}
          Save key
        </Button>
        {hasKey && editingKey && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { setEditingKey(false); setApiKeyInput(''); }}
            data-testid="button-cancel-key"
            className={dark ? 'text-white/50 hover:text-white/80' : ''}
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
