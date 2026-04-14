import { safeResponseJson } from "@/lib/safe-fetch";
import { useQuery } from "@tanstack/react-query";
import { setLeverageLimitsCache, tickerToMarket, getMaxLeverage as getFallbackMaxLeverage } from "@/lib/exchange-constants";

interface LeverageLimitsResponse {
  leverageLimits: Record<string, number>;
  source: string | null;
  lastUpdated: string | null;
  marketCount: number;
}

export function useLeverageLimits() {
  const query = useQuery<LeverageLimitsResponse>({
    queryKey: ["/api/exchange/leverage-limits"],
    queryFn: async () => {
      const res = await fetch("/api/exchange/leverage-limits");
      if (!res.ok) throw new Error("Failed to fetch leverage limits");
      const data = await safeResponseJson(res);
      if (!data?.leverageLimits || Object.keys(data.leverageLimits).length === 0) {
        throw new Error("Leverage cache not ready");
      }
      setLeverageLimitsCache(data.leverageLimits);
      return data;
    },
    staleTime: 12 * 60 * 60 * 1000,
    refetchInterval: 12 * 60 * 60 * 1000,
    retry: 5,
    retryDelay: (attempt) => Math.min(5000 * (attempt + 1), 30000),
  });

  const getMaxLeverage = (market: string): number => {
    const normalized = tickerToMarket(market);

    if (query.data?.leverageLimits) {
      return query.data.leverageLimits[normalized] ?? getFallbackMaxLeverage(market);
    }

    return getFallbackMaxLeverage(market);
  };

  return {
    leverageLimits: query.data?.leverageLimits ?? {},
    getMaxLeverage,
    isLoading: query.isLoading,
    source: query.data?.source ?? null,
  };
}
