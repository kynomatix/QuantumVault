import fs from 'node:fs';
import path from 'node:path';
const root=process.argv[2],handback=path.resolve(root,'../..');
const receipts=[];
for(const file of fs.readdirSync(root).filter(f=>/^fractal-.*\.log$/.test(f))){
 const bytes=fs.readFileSync(path.join(root,file));
 const text=(bytes[0]===255&&bytes[1]===254?bytes.toString('utf16le'):bytes.toString('utf8')).replace(/^\uFEFF/,'');
 for(const line of text.split(/\r?\n/).filter(l=>l.startsWith('STDOUT: {'))){
  const r=JSON.parse(line.slice(8));
  receipts.push({file,commitHash:r.sha??r.request?.tip??null,host:r.host,passed:r.passed,failed:r.failed,skipped:r.skipped,exitCode:r.exitCode,kind:r.kind,error:r.error??null});
 }
}
fs.writeFileSync(path.join(root,'test-run-inventory.json'),JSON.stringify({runs:receipts},null,2)+'\n');
let text=`Research validation. TEST REQUEST (owner): focused. TEST-RISK: REQUIRED. TEST-DEFECT: REQUIRED. Every test below ran on FRACTAL through bundle-v1. No laptop Vitest, npx, WSL, installation, database-reset capture, push or merge was used. All successful runs are build-time research evidence, not conductor gate evidence. Counts marked unknown belong to rejected requests and are not successful or failed tests.

| Evidence receipt | Commit hash | Host | Passed | Failed | Skipped | Exit / outcome |
| --- | --- | --- | --- | --- | --- | --- |
`;
for(const r of receipts)text+=`| ${r.file} | ${r.commitHash??'Request rejected before commit acceptance'} | ${r.host} | ${r.passed??'unknown'} | ${r.failed??'unknown'} | ${r.skipped??'unknown'} | ${r.exitCode}: ${r.kind}${r.error?'; '+r.error.replaceAll('|','/'):''} |\n`;
text+=`
Failed test attempts remain in the table. The frozen-data fixture needed its real data-hold schedule; the movement fixture needed an actually activated move. The subsequent movement/carry suite passed. The risk accounting suite passed 205 checks. Eight leveraged accounting cases and two gap-liquidation cases also passed. Four projection equality failures were trailing-zero formatting in the returned safety-envelope evidence; normalizing that field produced 18/18 passing accounting, projection and gap checks. Two attempted name-filter arguments were rejected by the runner. A larger later bundle hit its upload deadline; the narrower bundle passed. No rejected request is counted as validation.

First-hand source inventory:

| Check | Source and finding |
| --- | --- |
| Live stop | [lifecycle-policy.ts](../grid-backtest-r2-20261020/server/grid-bot/lifecycle-policy.ts:41) compares the observed mark with the stop. [lifecycle-service.ts](../grid-backtest-r2-20261020/server/grid-bot/lifecycle-service.ts:53) calls that trigger. |
| Canonical policy | Product validation remains unchanged. The research adapter signs actual generated endpoints, resolving one-tick last-line rounding at 6/14/30 intervals. Admission proves all six counts have zero canonical rejections. |
| Maximum leverage | [provision.ts](../grid-backtest-r2-20261020/server/grid-bot/provision.ts:55) validates market leverage and launch authority. |
| Live fee reserve | [provision.ts](../grid-backtest-r2-20261020/server/grid-bot/provision.ts:77) sizes investment after reserving entry fees. Research retains round-one full investment sizing, so projection admission is not full live-launch admission. |
| Stop clearance | [stop-clearance.ts](../grid-backtest-r2-20261020/server/grid-bot/stop-clearance.ts:60) uses the documented liquidation formula, and line 69 onward requires a tick-rounded 1% cushion. The actual pure function is called in research. [launch-authority.ts](../grid-backtest-r2-20261020/server/grid-bot/launch-authority.ts:147) checks observed position liquidation. |
| Maintenance | The generic adapter margin weight is not the liquidation maintenance rate. Research uses the documented 1/(2 × market maximum leverage). Current public maxima are frozen; their historical changes are unknown. |
| Builder fee | [pacifica-adapter.ts](../grid-backtest-r2-20261020/server/protocol/pacifica/pacifica-adapter.ts:418) comments that the registered rate is 0.001 and configures a 0.001 approval ceiling. Line 1239 reads the actual public builder fee rate; line 1258 separately reads its approval ceiling. No secret or environment values were inspected. Current charged rate cannot be certified from the static ceiling. |
| Fee schedule | [Pacifica fees](https://docs.pacifica.fi/trading-on-pacifica/trading-fees): Tier 1 0.015% maker / 0.040% taker; VIP 1 0% / 0.030%; no published maker rebate. |
| Funding | Frozen Pacifica public settled history for direct data. Earlier history uses actual OKX settled-payment CSV archives through the public historical-market-data endpoint. Missing payment coverage is rejected, not imputed as zero. Funding oracle prices are used where supplied; proxy event prices follow the declared candle path. |
| Liquidation | [Pacifica liquidations](https://docs.pacifica.fi/trading-on-pacifica/liquidations): documented maintenance, liquidation fee and backstop threshold. Traded-price mark proxy before Pacifica inception and current maintenance limits prevent historical venue-safety claims. |

Selection was preregistered and development choices retained before evaluation/proxy runs. Hunts are descriptive only. Scenarios overlap heavily; no independence, significance, portfolio compounding or guaranteed intrabar bounds are claimed. Fill, slippage and funding assumptions are in the phase method files.

The initial line-count fee/minimum category totals were wrong because their regex did not recognize the planner's exact messages. Corrected categories use the preserved rejection reasons; separate zero-maker planner calls supply minimum-only diagnostics. Original output remains intact, and neither admission nor performance changed.

The final snapshot scan is documented separately in REVIEW-SCAN-STATUS.md. A nonzero or incomplete scan leaves this research handback unsealed.
`;
fs.writeFileSync(path.join(handback,'VALIDATION.md'),text);
console.log(`Validation report: ${receipts.length} retained runner receipts`);
