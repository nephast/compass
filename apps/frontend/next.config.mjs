// Static export: plain files on S3 behind CloudFront (COMPASS-24). No server,
// so no server-side secrets to leak and nothing to patch at runtime.
/** @type {import('next').NextConfig} */
export default {
  output: "export",
  reactStrictMode: true,
  images: { unoptimized: true },
  poweredByHeader: false,
};
