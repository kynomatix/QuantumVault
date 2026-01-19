import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, stat, symlink, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "axios",
  "connect-pg-simple",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "pg",
  "stripe",
  "uuid",
  "ws",
  "zod",
  "zod-validation-error",
];

async function fixNestedDependencies() {
  console.log("Fixing nested @solana/web3.js dependencies...");
  
  const nestedPath = "node_modules/@pythnetwork/solana-utils/node_modules/jito-ts/node_modules/@solana/web3.js";
  const topLevelPath = "../../../../../../@solana/web3.js";
  
  try {
    if (existsSync(nestedPath)) {
      const stats = await stat(nestedPath);
      if (!stats.isSymbolicLink()) {
        await rm(nestedPath, { recursive: true, force: true });
        await symlink(topLevelPath, nestedPath);
        console.log("Replaced nested @solana/web3.js with symlink to top-level version");
      } else {
        console.log("Nested @solana/web3.js is already symlinked");
      }
    }
  } catch (error) {
    console.warn("Could not fix nested dependencies:", error);
  }
}

async function buildAll() {
  await fixNestedDependencies();
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    target: "node20",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.url": '""',
      "__ESBUILD_CJS_BUNDLE__": "true",
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
