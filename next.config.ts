import type { NextConfig } from "next";

function supabaseImageHostname(): string | null {
  const value = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (!value) {
    return null;
  }

  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

const imageHostname = supabaseImageHostname();

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactCompiler: true,
  experimental: {
    serverActions: {
      bodySizeLimit: "6mb",
    },
  },
  images: {
    remotePatterns: imageHostname
      ? [
          {
            protocol: "https",
            hostname: imageHostname,
            pathname: "/storage/v1/object/public/product-photos/**",
          },
        ]
      : [],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
