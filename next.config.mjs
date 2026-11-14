/** @type {import('next').NextConfig} */
const nextConfig = {
  // 这些包必须在 Node 运行时按原样加载，不能被 webpack 打包：
  // - pi-* : ESM-only，打包后会破坏动态 import
  // - @prisma/client : 需要原生引擎
  // - ws : 打包后其原生加速模块探测逻辑失效，发送二进制帧会抛
  //        "bufferUtil.mask is not a function"
  serverExternalPackages: [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-schema",
    "@prisma/client",
    "ws",
  ],
};

export default nextConfig;