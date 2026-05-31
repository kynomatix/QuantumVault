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

export function getAdapterForBot(bot: { id?: number | string; activeProtocol: 'pacifica' | 'drift' | 'flash' }): ProtocolAdapter {
  // Group D item 18 (April 17, 2026) made trading_bots.active_protocol NOT NULL with
  // a CHECK constraint locking it to ('pacifica','drift'), and the four routes.ts
  // insert sites that previously emitted NULL were fixed in the same atomic diff.
  // The schema-level $type union narrows the parameter so callers cannot pass null.
  // The read-side null fallback that used to live here (warn + default-adapter) is
  // therefore structurally unreachable and was removed alongside item 18 closeout.
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
