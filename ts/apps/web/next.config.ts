import { resolve } from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone', // Docker: deploy/compose/web.Dockerfile chạy .next/standalone
  // gốc workspace ts/ (node_modules hoist ở đó); `next build` chạy với cwd = apps/web
  outputFileTracingRoot: resolve(process.cwd(), '../..'),
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
