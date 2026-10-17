import type { NextConfig } from "next";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  // Emits .next/standalone with a self-contained server.js and a traced subset
  // of node_modules, so the runtime image ships neither the dev dependencies
  // nor the whole install tree. `next start` still works locally either way.
  output: "standalone",
  async rewrites() {
    // D-03: same origin. /api/* is proxied to FastAPI; no CORS in production.
    //
    // WARNING: this destination is resolved during `next build` and frozen into
    // .next/routes-manifest.json. Setting API_ORIGIN when the container starts
    // does NOT change it -- it would only reach src/lib/dal.ts, leaving the
    // rewrite aimed at the address it was built with. Both must be given the
    // same value; the Dockerfile passes it as a build arg for exactly this
    // reason.
    return [
      { source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` },
    ];
  },
};

export default nextConfig;