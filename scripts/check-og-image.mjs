#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
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
if (!existsSync(IMAGE)) fail(`client/public/og-image-v3.jpg is missing. Restore it from git history.`);

const html = readFileSync(HTML, 'utf8');
for (const tag of REQUIRED_TAGS) {
  if (!html.includes(tag)) {
    fail(`Required tag missing or modified in client/index.html:\n  ${tag}`);
  }
}

console.log(`${GREEN}✓ OG image guard: tags intact, image file present.${RESET}`);
