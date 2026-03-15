#!/bin/bash
set -e
echo "[post-merge] Reconciling environment..."
npm install --prefer-offline --no-audit --no-fund
echo "[post-merge] Done."
