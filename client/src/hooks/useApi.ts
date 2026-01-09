import { useQuery } from "@tanstack/react-query";
import { useWallet } from "./useWallet";

async function fetchPrices(): Promise<Record<string, number>> {
  const res = await fetch("/api/prices");
  if (!res.ok) throw new Error("Failed to fetch prices");
  return res.json();
}

async function fetchTradingBots(walletAddress: string) {
  const res = await fetch(`/api/trading-bots?wallet=${walletAddress}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch trading bots");
  return res.json();
}

export function usePrices() {
  return useQuery({
    queryKey: ["prices"],
    queryFn: fetchPrices,
    refetchInterval: 10000,
    staleTime: 5000,
  });
}

export function useTradingBots() {
  const { publicKeyString } = useWallet();
  return useQuery({
    queryKey: ["tradingBots", publicKeyString],
    queryFn: () => fetchTradingBots(publicKeyString!),
    enabled: !!publicKeyString,
  });
}
