import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // A1 (2026-10-30): la URL del Front v2 paso de /v2 a /panel (lib/v2/rutas.ts).
  // Redireccion permanente (308) para marcadores y enlaces viejos.
  async redirects() {
    return [
      { source: "/v2", destination: "/panel", permanent: true },
      { source: "/v2/:path*", destination: "/panel/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
