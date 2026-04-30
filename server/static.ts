import express, { type Express, type Request, type Response, type NextFunction } from "express";
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

  // Replit autoscale wraps every response in `Cache-Control: private, max-age=0`,
  // which breaks public asset fetchers — most notoriously social-card crawlers
  // (X / Facebook / LinkedIn) which refuse to cache or render images marked
  // `private`. Force public, cacheable headers for static assets so OG images,
  // favicons, and other public files behave correctly when fetched by bots and
  // shared CDNs. Applied BEFORE express.static so the file response inherits
  // these headers.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const ext = path.extname(req.path).toLowerCase();
    const isPublicAsset =
      [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico",
       ".woff", ".woff2", ".ttf", ".otf",
       ".css", ".js", ".mjs", ".map",
       ".txt", ".xml", ".json"].includes(ext);
    if (isPublicAsset) {
      // 1 day for assets at the root (favicon, og image, robots.txt, sitemap)
      // and 1 year for hashed asset bundles in /assets/.
      const isHashedBundle = req.path.startsWith("/assets/");
      const maxAge = isHashedBundle ? 31536000 : 86400;
      res.setHeader(
        "Cache-Control",
        `public, max-age=${maxAge}${isHashedBundle ? ", immutable" : ""}`,
      );
      // Drop any session-affinity cookies the upstream may try to attach to
      // a static asset response — they have no business being on shared assets.
      res.removeHeader("Set-Cookie");
    }
    next();
  });

  app.use(express.static(distPath, {
    setHeaders: (res, filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      const isHashedBundle = filePath.includes(`${path.sep}assets${path.sep}`);
      if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico",
           ".woff", ".woff2", ".ttf", ".otf",
           ".css", ".js", ".mjs", ".map",
           ".txt", ".xml", ".json"].includes(ext)) {
        const maxAge = isHashedBundle ? 31536000 : 86400;
        res.setHeader(
          "Cache-Control",
          `public, max-age=${maxAge}${isHashedBundle ? ", immutable" : ""}`,
        );
      }
    },
  }));

  // fall through to index.html if the file doesn't exist
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
