import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  // In bundled CJS, __dirname might not be correct. Use process.cwd() as base
  // and check both dist/public (from project root) and __dirname/public
  let distPath = path.resolve(process.cwd(), "dist", "public");
  
  // Fallback to __dirname-relative path if process.cwd() doesn't work
  if (!fs.existsSync(distPath)) {
    distPath = path.resolve(__dirname, "public");
  }
  
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory at ${distPath}, make sure to build the client first`,
    );
  }

  console.log(`[static] Serving static files from: ${distPath}`);
  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
