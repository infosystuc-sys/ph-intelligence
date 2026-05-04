import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
