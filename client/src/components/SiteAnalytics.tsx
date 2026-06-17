import { useEffect } from "react";

/**
 * Privacy-first, env-gated site analytics loader.
 *
 * What it does:
 * - OFF by default. If VITE_PLAUSIBLE_DOMAIN is not set, this renders nothing and
 *   injects no script, so local dev (and any build without the env var) stays clean.
 * - When VITE_PLAUSIBLE_DOMAIN is set to your site domain (e.g. "myquantumvault.com"),
 *   it loads Plausible: a lightweight, cookieless analytics script. It collects no
 *   personal data, sets no cookies, and needs no cookie banner. You get traffic,
 *   referrers, and top pages, nothing that identifies a visitor.
 * - Optional VITE_PLAUSIBLE_SRC lets you point at a self-hosted or proxied script
 *   URL. It defaults to the official Plausible cloud script.
 *
 * One-time setup (no code change needed):
 * 1. Create a free site at https://plausible.io (or self-host it).
 * 2. Set the secret VITE_PLAUSIBLE_DOMAIN to your domain, then redeploy.
 *
 * Free alternative: Cloudflare Web Analytics is also cookieless and free. To use
 * it instead, you would swap the script URL/attributes below for Cloudflare's beacon.
 */
export default function SiteAnalytics() {
  useEffect(() => {
    const env = (import.meta as any).env || {};
    const domain: string | undefined = env.VITE_PLAUSIBLE_DOMAIN;
    if (!domain) return;
    if (typeof document === "undefined") return;
    if (document.querySelector('script[data-analytics="plausible"]')) return;

    const src: string = env.VITE_PLAUSIBLE_SRC || "https://plausible.io/js/script.js";

    const s = document.createElement("script");
    s.defer = true;
    s.src = src;
    s.setAttribute("data-domain", domain);
    s.setAttribute("data-analytics", "plausible");
    document.head.appendChild(s);
  }, []);

  return null;
}
