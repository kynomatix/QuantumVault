#!/usr/bin/env node
/**
 * Lightweight Gemini CLI for QuantumVault dev tooling.
 *
 * NOT wired into the production server — used by the agent (and you) for:
 *   - Plan/code audits        (text → text, gemini-2.5-pro)
 *   - UX critique             (text + screenshot → text, gemini-2.5-pro)
 *   - Mockup image generation (text → image, gemini-2.5-flash-image / "Nano Banana")
 *
 * Auth: prefers GEMINI_API_KEY (direct Google AI Studio — supports Gemini 3 Pro and latest models).
 * Falls back to AI_INTEGRATIONS_GEMINI_API_KEY + AI_INTEGRATIONS_GEMINI_BASE_URL (Replit proxy, 2.5 family only).
 *
 * Usage:
 *   node scripts/gemini.mjs --prompt-file p.txt
 *   echo "audit this" | node scripts/gemini.mjs
 *   node scripts/gemini.mjs --prompt "critique this mockup" --image ui.png
 *   node scripts/gemini.mjs --image-out --prompt "Dark fintech dashboard, ..." --out mock.png
 *   node scripts/gemini.mjs --model gemini-2.5-flash --max-tokens 32000 --prompt-file p.txt
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI, Modality } from '@google/genai';

function parseArgs(argv) {
  const args = { model: null, maxTokens: 16384, imageOut: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--model': args.model = next(); break;
      case '--prompt': args.prompt = next(); break;
      case '--prompt-file': args.promptFile = next(); break;
      case '--image': (args.images ||= []).push(next()); break;
      case '--out': args.out = next(); break;
      case '--max-tokens': args.maxTokens = parseInt(next(), 10); break;
      case '--image-out': args.imageOut = true; break;
      case '-h': case '--help': args.help = true; break;
      default: console.error(`Unknown arg: ${a}`); process.exit(2);
    }
  }
  return args;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

async function loadImagePart(p) {
  const data = await fs.readFile(p);
  const ext = path.extname(p).toLowerCase();
  const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp' : 'image/png';
  return { inlineData: { mimeType, data: data.toString('base64') } };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(await fs.readFile(new URL(import.meta.url), 'utf-8').then(s => s.split('*/')[0]));
    return;
  }
  const directKey = process.env.GEMINI_API_KEY;
  const proxyKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  if (!directKey && !proxyKey) {
    console.error('Missing GEMINI_API_KEY (direct) or AI_INTEGRATIONS_GEMINI_API_KEY (Replit proxy)');
    process.exit(1);
  }

  const useDirect = !!directKey;
  const defaultTextModel = useDirect ? 'gemini-3.1-pro' : 'gemini-2.5-pro';
  const model = args.model || (args.imageOut ? 'gemini-2.5-flash-image' : defaultTextModel);
  let prompt = args.prompt || '';
  if (args.promptFile) prompt += (prompt ? '\n\n' : '') + await fs.readFile(args.promptFile, 'utf-8');
  if (!prompt) prompt = await readStdin();
  if (!prompt.trim()) { console.error('No prompt provided'); process.exit(2); }

  const parts = [{ text: prompt }];
  for (const p of (args.images || [])) parts.push(await loadImagePart(p));

  const ai = useDirect
    ? new GoogleGenAI({ apiKey: directKey })
    : new GoogleGenAI({
        apiKey: proxyKey,
        httpOptions: { apiVersion: '', baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL },
      });

  const config = { maxOutputTokens: args.maxTokens };
  if (args.imageOut) config.responseModalities = [Modality.TEXT, Modality.IMAGE];

  const start = Date.now();
  const res = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config,
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (args.imageOut) {
    const cand = res.candidates?.[0];
    const imgPart = cand?.content?.parts?.find(p => p.inlineData);
    if (!imgPart) { console.error(`[${elapsed}s] No image returned. Text:\n${res.text || ''}`); process.exit(1); }
    const outPath = args.out || `gemini-${Date.now()}.png`;
    await fs.writeFile(outPath, Buffer.from(imgPart.inlineData.data, 'base64'));
    console.error(`[${elapsed}s] Saved: ${outPath}`);
    const txt = cand.content.parts.find(p => p.text)?.text;
    if (txt) console.log(txt);
  } else {
    const txt = res.text || '';
    if (args.out) await fs.writeFile(args.out, txt);
    console.error(`[${elapsed}s] ${txt.length} chars${args.out ? ` → ${args.out}` : ''}`);
    if (!args.out) console.log(txt);
  }
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
