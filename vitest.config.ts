import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    exclude: [...configDefaults.exclude, ".research-private/**"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
