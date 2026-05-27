#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const HTML = resolve(ROOT, 'client/index.html');
const IMAGE = resolve(ROOT, 'client/public/og-image-v3.jpg');

const REQUIRED_OG = 'https://myquantumvault.com/og-image-v3.jpg';
const REQUIRED_TAGS = [
  `<meta property="og:image" content="${REQUIRED_OG}" />`,
  `<meta name="twitter:image" content="${REQUIRED_OG}" />`,
];

// Locked SHA-256 of the canonical og-image-v3.jpg (71,019 bytes).
// If this hash ever needs to change, the USER must update it manually after
// approving a new image. Agents must NEVER edit this constant.
const REQUIRED_IMAGE_SHA256 = '63f9bc12724e6b97936a32611015478508f4f4eb9836e1c262d2378a007e0012';
const REQUIRED_IMAGE_BYTES = 71019;

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function fail(msg) {
  console.error(`\n${RED}${BOLD}╔══════════════════════════════════════════════════════════════╗${RESET}`);
  console.error(`${RED}${BOLD}║  OG IMAGE GUARD: BUILD BLOCKED                               ║${RESET}`);
  console.error(`${RED}${BOLD}╚══════════════════════════════════════════════════════════════╝${RESET}`);
  console.error(`${RED}${msg}${RESET}`);
  console.error(`\n${BOLD}The OG image is locked. Do NOT modify:${RESET}`);
  console.error(`  - client/index.html  (og:image + twitter:image tags)`);
  console.error(`  - client/public/og-image-v3.jpg`);
  console.error(`\nRequired tags (exact):`);
  for (const t of REQUIRED_TAGS) console.error(`  ${t}`);
  console.error('');
  process.exit(1);
}

if (!existsSync(HTML)) fail(`client/index.html not found.`);
if (!existsSync(IMAGE)) fail(`client/public/og-image-v3.jpg is missing. Restore it from git history:\n  git checkout 6df6b1d -- client/public/og-image-v3.jpg`);

const html = readFileSync(HTML, 'utf8');
for (const tag of REQUIRED_TAGS) {
  if (!html.includes(tag)) {
    fail(`Required tag missing or modified in client/index.html:\n  ${tag}`);
  }
}

const imageBuf = readFileSync(IMAGE);
const actualSize = imageBuf.length;
const actualHash = createHash('sha256').update(imageBuf).digest('hex');

if (actualSize !== REQUIRED_IMAGE_BYTES || actualHash !== REQUIRED_IMAGE_SHA256) {
  fail(
    `client/public/og-image-v3.jpg HAS BEEN MODIFIED.\n` +
    `  expected size:   ${REQUIRED_IMAGE_BYTES} bytes\n` +
    `  actual size:     ${actualSize} bytes\n` +
    `  expected sha256: ${REQUIRED_IMAGE_SHA256}\n` +
    `  actual sha256:   ${actualHash}\n\n` +
    `Restore the canonical image from git:\n` +
    `  git checkout 6df6b1d -- client/public/og-image-v3.jpg`
  );
}

console.log(`${GREEN}✓ OG image guard: tags intact, image bytes match locked sha256 (${actualSize} bytes).${RESET}`);
