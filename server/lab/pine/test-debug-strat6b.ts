import { labStorage } from "../storage";

async function main() {
  const strategy = await labStorage.getStrategy(6);
  if (!strategy) { process.exit(1); }
  const lines = strategy.pineScript.split('\n');
  // Show lines 240-340 for entry/var init/stop computation
  for (let i = 240; i <= 340; i++) {
    console.log(`${i}: ${lines[i]}`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
