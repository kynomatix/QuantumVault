import { labStorage } from "../storage";
async function main() {
  const strategy = await labStorage.getStrategy(6);
  if (!strategy) process.exit(1);
  const lines = strategy.pineScript.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('slOnClose') || lines[i].includes('sl_on_close') || lines[i].includes('slATRmult') || lines[i].includes('slPercent') || lines[i].includes('useStopLoss') || lines[i].includes('useTrailing')) {
      console.log(`${i}: ${lines[i]}`);
    }
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
