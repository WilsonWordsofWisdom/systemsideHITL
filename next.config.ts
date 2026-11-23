import type { NextConfig } from "next";

// cacheComponents and partialPrefetching are off: every page renders fully on the
// server so agents receive complete HTML rather than streamed placeholders
// (decision 2026-11-22).

// Baseline security headers (control S4). The page never needs to be framed
// (control W10). A script-src policy needs nonces and is added in a later phase.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // The policy files are read from disk at runtime, so they must ship with every
  // server function (lib/hitl/policy.ts, lib/hitl/classifier.ts).
  outputFileTracingIncludes: { "/**": ["./policy/*.yaml"] },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // The console is admin only and must not be indexed (FR39).
      { source: "/console/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] },
      { source: "/console", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] },
    ];
  },
};

export default nextConfig;
