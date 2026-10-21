#!/usr/bin/env bash
set -euo pipefail
repo=$1
out=$2
base=$3
main=$4
test ! -e "$out"
mkdir -p "$out"
git clone -q --shared --no-checkout "$repo" "$out/repo"
cd "$out/repo"
git config core.autocrlf false
git checkout -q -b sizing-stops-delivery "$base"
cp -R "$repo/scripts/research/grid-sizing-stops" scripts/research/
cp "$repo/tests/research/grid-sizing-stops.test.ts" tests/research/
git add -- scripts/research/grid-sizing-stops tests/research/grid-sizing-stops.test.ts
git -c user.name='Research Job' -c user.email='research@local' commit -q -m 'research: order sizing and stop variants with funded replay evidence' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
tip=$(git rev-parse HEAD)
git update-ref refs/heads/qv-probe-tip "$tip"
git update-ref refs/heads/qv-probe-main "$main"
git bundle create -q ../probe.bundle refs/heads/qv-probe-tip refs/heads/qv-probe-main "^$main^1"
git bundle verify ../probe.bundle > ../bundle-verify.log 2>&1
printf 'commitHash=%s\n' "$tip"
