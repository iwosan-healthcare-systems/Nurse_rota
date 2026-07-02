import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

export default defineConfig(({ mode }) => {
  const loadedEnv = loadEnv(mode, process.cwd(), "VITE_");
  const envDefine: Record<string, string> = {};
  for (const [key, value] of Object.entries(loadedEnv)) {
    envDefine[`import.meta.env.${key}`] = JSON.stringify(value);
  }

  return {
    plugins: [
      tanstackRouter({ autoCodeSplitting: true }),
      tailwindcss(),
      tsconfigPaths({ projects: ["./tsconfig.json"] }),
      react(),
    ],
    define: envDefine,
    resolve: {
      alias: {
        "@": `${process.cwd()}/src`,
      },
      dedupe: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@tanstack/react-query",
        "@tanstack/query-core",
      ],
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            "vendor-tanstack": [
              "@tanstack/react-router",
              "@tanstack/react-query",
              "@tanstack/query-core",
            ],
            "vendor-supabase": ["@supabase/supabase-js"],
          },
        },
      },
    },
    server: {
      host: "::",
      port: 5000,
    },
  };
});
