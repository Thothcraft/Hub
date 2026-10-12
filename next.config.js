/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': require('path').resolve(__dirname),
    };
    return config;
  },
  images: {
    domains: ['localhost'],
  },
  // Enable static exports for full static site generation
  output: 'standalone',
  typescript: {
    // Type errors fail the build — fix them, don't hide them.
    ignoreBuildErrors: false,
  },
  eslint: {
    // Lint errors fail the build.
    ignoreDuringBuilds: false,
  },
};

module.exports = nextConfig;
