import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        environment: "node",
        globals: false,
        include: ["tests/**/*.test.ts"],
        setupFiles: ["tests/setup.ts"],
        // Reservation tests serialise on shared (productId, warehouseId) rows
        // even when data is per-test; running files in parallel would also
        // multiply load on Neon + Upstash unnecessarily.
        fileParallelism: false,
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});
