import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, stat, symlink, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { resolveGitBuildIdentity } from "./git-build-identity";

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
  "http-proxy-middleware",
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
  const buildIdentity = resolveGitBuildIdentity();
  if (buildIdentity.identityVerified) {
    console.log(
      `[BuildIdentity] commit=${buildIdentity.commitSha.slice(0, 12)} tree=${buildIdentity.treeSha.slice(0, 12)}`,
    );
  } else {
    console.warn(`[BuildIdentity] unverified reason=${buildIdentity.reason}`);
  }

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
      "__QV_BUILD_COMMIT_SHA__": JSON.stringify(buildIdentity.commitSha),
      "__QV_BUILD_TREE_SHA__": JSON.stringify(buildIdentity.treeSha),
      "__QV_BUILD_IDENTITY_VERIFIED__": JSON.stringify(buildIdentity.identityVerified),
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });

  console.log("building lab server...");
  await esbuild({
    entryPoints: ["server/lab/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/lab-server.cjs",
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

  console.log("building optimizer worker...");
  await esbuild({
    entryPoints: ["server/lab/optimizer-worker.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/optimizer-worker.cjs",
    target: "node20",
    define: {
      "process.env.NODE_ENV": '"production"',
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
