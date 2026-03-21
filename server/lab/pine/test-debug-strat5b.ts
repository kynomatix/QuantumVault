import { labStorage } from "../storage";

async function main() {
  const strategy = await labStorage.getStrategy(5);
  if (!strategy) { process.exit(1); }
  const lines = strategy.pineScript.split('\n');
  // Show lines 340-440 for SuperTrend and entry signal logic
  for (let i = 345; i <= 440; i++) {
    console.log(`${i}: ${lines[i]}`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
