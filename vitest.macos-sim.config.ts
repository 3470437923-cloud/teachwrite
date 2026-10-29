import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

/**
 * 伪装 macOS 的 vitest 配置。
 *
 * 与 `vite.config.ts` 里的测试配置**刻意保持一致**（alias / include / environment），
 * 唯一差别是 `setupFiles` 注入 `vitest.macos-sim.setup.ts` 把 `process.platform`
 * 改成 `darwin`。详见那个文件的注释。
 *
 * 放在项目根目录（而不是 tools/）是**有意的**：vitest 的 `root` 默认取配置
 * 文件所在目录，挪到 tools/ 会让 `tests/**` 和 `./src` 全部解析错位。
 *
 * 用法：`npm run test:macos-sim`
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
    setupFiles: ["./vitest.macos-sim.setup.ts"],
  },
});
