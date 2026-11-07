import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The candle files never change for a given ?v= build stamp.
  async headers() {
    return [{ source: "/market/:path*.bin", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] }];
  },
};

export default nextConfig;
