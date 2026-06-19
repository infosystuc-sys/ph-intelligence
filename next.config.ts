import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Cachea las respuestas de fetch de Server Components entre refreshes de HMR
    // en dev — evita re-pedir los mismos datos en cada guardado de archivo.
    serverComponentsHmrCache: true,
  },
  async redirects() {
    return [
      { source: '/', destination: '/dashboard', permanent: false },
    ]
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'dcdn-us.mitiendanube.com',
      },
      {
        protocol: 'https',
        hostname: '*.supabase.co',
      },
      {
        protocol: 'https',
        hostname: '*.supabase.storage',
      },
    ],
  },
};

export default nextConfig;
