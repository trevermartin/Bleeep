/** @type {import('next').NextConfig} */
const nextConfig = {
  // Required for fluent-ffmpeg and ffmpeg-static in API routes (Next.js 14 key)
  experimental: {
    serverComponentsExternalPackages: ['fluent-ffmpeg', 'ffmpeg-static'],
  },

  // Image optimization
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
      },
    ],
  },
};

export default nextConfig;
