export interface SymbolMapping {
  internal: string;
  protocol: string;
  aliases: string[];
}

const MAX_REGISTRY_SIZE = 500;

export class SymbolRegistry {
  private toProtocol: Map<string, string>;
  private toInternal: Map<string, string>;

  constructor(mappings: SymbolMapping[]) {
    if (mappings.length > MAX_REGISTRY_SIZE) {
      throw new Error(
        `SymbolRegistry: ${mappings.length} mappings exceeds max of ${MAX_REGISTRY_SIZE}`,
      );
    }

    this.toProtocol = new Map();
    this.toInternal = new Map();

    for (const mapping of mappings) {
      const internalUpper = mapping.internal.toUpperCase();
      const protocolUpper = mapping.protocol.toUpperCase();

      if (this.toProtocol.has(internalUpper)) {
        throw new Error(
          `SymbolRegistry: duplicate internal symbol "${mapping.internal}" — ` +
          `already mapped to "${this.toProtocol.get(internalUpper)}"`,
        );
      }

      if (this.toInternal.has(protocolUpper)) {
        throw new Error(
          `SymbolRegistry: duplicate protocol symbol "${mapping.protocol}" — ` +
          `internal symbols "${this.toInternal.get(protocolUpper)}" and "${mapping.internal}" collide`,
        );
      }

      this.toProtocol.set(internalUpper, mapping.protocol);
      this.toInternal.set(protocolUpper, mapping.internal);

      for (const alias of mapping.aliases) {
        const aliasUpper = alias.toUpperCase();
        if (this.toInternal.has(aliasUpper)) {
          throw new Error(
            `SymbolRegistry: alias "${alias}" collides with existing mapping to "${this.toInternal.get(aliasUpper)}"`,
          );
        }
        this.toInternal.set(aliasUpper, mapping.internal);
      }
    }
  }

  internalToProtocol(internal: string): string {
    const result = this.toProtocol.get(internal.toUpperCase());
    if (result === undefined) {
      throw new Error(`SymbolRegistry: unknown internal symbol "${internal}"`);
    }
    return result;
  }

  protocolToInternal(protocol: string): string {
    const result = this.toInternal.get(protocol.toUpperCase());
    if (result === undefined) {
      throw new Error(`SymbolRegistry: unknown protocol symbol "${protocol}"`);
    }
    return result;
  }

  isKnownInternal(symbol: string): boolean {
    return this.toProtocol.has(symbol.toUpperCase());
  }

  isKnownProtocol(symbol: string): boolean {
    return this.toInternal.has(symbol.toUpperCase());
  }

  getAllInternalSymbols(): string[] {
    return Array.from(new Set(this.toInternal.values()));
  }

  getAllProtocolSymbols(): string[] {
    return Array.from(this.toProtocol.values());
  }
}

export function normalizeMarket(symbol: string): string {
  return symbol
    .toUpperCase()
    .replace(/-PERP$/i, '')
    .replace(/PERP$/i, '')
    .replace(/USD[CT]?$/i, '')
    .replace(/[-_/]/g, '');
}

const PACIFICA_SPECIAL_CASES: Record<string, string> = {
  '1MBONK-PERP': 'kBONK',
  '1MPEPE-PERP': 'kPEPE',
};

const PACIFICA_REVERSE_SPECIAL: Record<string, string> = {
  'KBONK': '1MBONK-PERP',
  'KPEPE': '1MPEPE-PERP',
};

export function buildPacificaMappings(
  pacificaSymbols: string[],
): SymbolMapping[] {
  const mappings: SymbolMapping[] = [];

  const specialProtocolSymbols = new Set(
    Object.values(PACIFICA_SPECIAL_CASES).map((s) => s.toUpperCase()),
  );

  for (const [internal, protocol] of Object.entries(PACIFICA_SPECIAL_CASES)) {
    mappings.push({ internal, protocol, aliases: [] });
  }

  for (const protocolSymbol of pacificaSymbols) {
    const upper = protocolSymbol.toUpperCase();
    if (specialProtocolSymbols.has(upper)) {
      continue;
    }

    const reverseSpecial = PACIFICA_REVERSE_SPECIAL[upper];
    if (reverseSpecial) {
      continue;
    }

    const internal = `${protocolSymbol.toUpperCase()}-PERP`;
    mappings.push({
      internal,
      protocol: protocolSymbol,
      aliases: [],
    });
  }

  return mappings;
}
