$ErrorActionPreference='Stop'
$researchRoot=(Get-Content -LiteralPath '..\grid-backtest-r2-20261020-handback\evidence-root.txt' -Raw).Trim()
$checkpoint='..\grid-backtest-r2-20261020-handback\RESUME.md'
$phaseWorker=Get-Process -Id 21800 -ErrorAction SilentlyContinue
if($phaseWorker){
    $expected=[datetime]'2026-10-20T07:11:48.3236315Z'
    if([Math]::Abs(($phaseWorker.StartTime.ToUniversalTime()-$expected.ToUniversalTime()).TotalSeconds)-gt 2){throw 'Worker identity changed'}
    $phaseWorker.WaitForExit()
}
if(!(Test-Path -LiteralPath "$researchRoot\phase-c-lines-proxy-complete.json")){throw 'Line/fee phase did not finish successfully'}
$env:GRID_TRAIL_VENDOR='C:\Apps\Replit\conductor-worktrees\grid-trail-backtest-20261019-handback\evidence\vendor'
Add-Content -LiteralPath $checkpoint -Value "`nLines/fees completed $(Get-Date -Format o); sequential phase continuation begins."
foreach($phase in @('phase-c-movement','phase-c-risk','line-diagnostics','phase-b-mark-held','phase-d')){
    & node --disable-warning=ExperimentalWarning --experimental-transform-types --import ./scripts/research/grid-backtest-r2/loader.mjs "scripts/research/grid-backtest-r2/$phase.mjs" $researchRoot *> "$researchRoot/$phase-run.log"
    if($LASTEXITCODE -ne 0){
        Add-Content -LiteralPath $checkpoint -Value "`nSTOP: $phase exited $LASTEXITCODE at $(Get-Date -Format o). See its retained run log. No later phase started."
        throw "$phase failed with exit $LASTEXITCODE"
    }
    Add-Content -LiteralPath $checkpoint -Value "`nCompleted $phase at $(Get-Date -Format o). Exact results and rejection reasons retained in its evidence files."
    Write-Output "Completed $phase"
}
& node --disable-warning=ExperimentalWarning --experimental-transform-types --import ./scripts/research/grid-backtest-r2/loader.mjs scripts/research/grid-backtest-r2/report.mjs $researchRoot
if($LASTEXITCODE -ne 0){throw 'Final report generation failed'}
& node scripts/research/grid-backtest-r2/validation-report.mjs $researchRoot
if($LASTEXITCODE -ne 0){throw 'Validation report generation failed'}
Add-Content -LiteralPath $checkpoint -Value "`nAll computation phases and reports complete $(Get-Date -Format o). Remaining: final source/evidence review and readonly snapshot secret scan. Not sealed."
