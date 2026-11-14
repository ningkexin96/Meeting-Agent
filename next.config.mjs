/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-schema",
    "@prisma/client",
  ],
};

export default nextConfig;