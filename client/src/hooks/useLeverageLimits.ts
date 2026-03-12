import { useQuery } from "@tanstack/react-query";
import { setLeverageLimitsCache } from "@/lib/drift-constants";

const CONSERVATIVE_FALLBACK = 5;

interface LeverageLimitsResponse {
  leverageLimits: Record<string, number>;
  source: string | null;
  lastUpdated: string | null;
  marketCount: number;
}

export function useLeverageLimits() {
  const query = useQuery<LeverageLimitsResponse>({
    queryKey: ["/api/drift/leverage-limits"],
    queryFn: async () => {
      const res = await fetch("/api/drift/leverage-limits");
      if (!res.ok) throw new Error("Failed to fetch leverage limits");
      const data = await res.json();
      if (data?.leverageLimits && Object.keys(data.leverageLimits).length > 0) {
        setLeverageLimitsCache(data.leverageLimits);
      }
      return data;
    },
    staleTime: 12 * 60 * 60 * 1000,
    refetchInterval: 12 * 60 * 60 * 1000,
    retry: 2,
  });

  const getMaxLeverage = (market: string): number => {
    const normalized = market.toUpperCase().includes('-PERP')
      ? market.toUpperCase()
      : `${market.toUpperCase()}-PERP`;

    if (query.data?.leverageLimits) {
      return query.data.leverageLimits[normalized] ?? CONSERVATIVE_FALLBACK;
    }

    return CONSERVATIVE_FALLBACK;
  };

  return {
    leverageLimits: query.data?.leverageLimits ?? {},
    getMaxLeverage,
    isLoading: query.isLoading,
    source: query.data?.source ?? null,
  };
}
