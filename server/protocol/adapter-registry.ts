import type { ProtocolAdapter } from './adapter.js';

export type AdapterHealth = 'initializing' | 'ready' | 'degraded' | 'unavailable';

const MAX_ADAPTERS = 10;

const adapters = new Map<string, ProtocolAdapter>();
const adapterHealth = new Map<string, AdapterHealth>();
let defaultAdapterId: string = 'pacifica';

export function registerAdapter(adapter: ProtocolAdapter): void {
  if (adapters.size >= MAX_ADAPTERS && !adapters.has(adapter.protocolName)) {
    throw new Error(
      `AdapterRegistry: max adapters (${MAX_ADAPTERS}) reached — cannot register "${adapter.protocolName}"`,
    );
  }
  adapters.set(adapter.protocolName, adapter);
  adapterHealth.set(adapter.protocolName, 'initializing');
}

export function setAdapterHealth(protocolName: string, health: AdapterHealth): void {
  if (!adapters.has(protocolName)) {
    throw new Error(`AdapterRegistry: unknown protocol "${protocolName}"`);
  }
  adapterHealth.set(protocolName, health);
}

export function getAdapterHealth(protocolName: string): AdapterHealth {
  return adapterHealth.get(protocolName) || 'unavailable';
}

export function getDefaultAdapter(): ProtocolAdapter {
  const adapter = adapters.get(defaultAdapterId);
  if (!adapter) {
    throw new Error(`AdapterRegistry: no adapter registered for default "${defaultAdapterId}"`);
  }
  return adapter;
}

export function getAdapterForBot(bot: { id?: number | string; activeProtocol: string | null }): ProtocolAdapter {
  if (!bot.activeProtocol) {
    const fallback = getDefaultAdapter();
    console.warn(
      `[AdapterRegistry] Bot ${bot.id ?? '<unknown>'} has activeProtocol=null; falling back to default adapter "${fallback.protocolName}". ` +
      `This is safe today (single-protocol) but MUST be resolved before a second adapter (Drift) is registered — backfill active_protocol on legacy bots.`,
    );
    return fallback;
  }
  const adapter = adapters.get(bot.activeProtocol);
  if (!adapter) {
    throw new Error(
      `AdapterRegistry: bot has active_protocol="${bot.activeProtocol}" but no adapter is registered for it. ` +
      `Registered adapters: [${Array.from(adapters.keys()).join(', ') || 'none'}]. ` +
      `This is a configuration bug — do not silently fall back to the default adapter, as it would route the trade to the wrong protocol.`,
    );
  }
  return adapter;
}

export function getAdapter(protocolName: string): ProtocolAdapter {
  const adapter = adapters.get(protocolName);
  if (!adapter) {
    throw new Error(`AdapterRegistry: no adapter registered for "${protocolName}"`);
  }
  return adapter;
}

export function setDefaultAdapter(protocolName: string): void {
  if (!adapters.has(protocolName)) {
    throw new Error(`AdapterRegistry: unknown protocol "${protocolName}"`);
  }
  defaultAdapterId = protocolName;
}

export function listAdapters(): string[] {
  return Array.from(adapters.keys());
}

export function unregisterAdapter(protocolName: string): void {
  adapters.delete(protocolName);
  adapterHealth.delete(protocolName);
}
