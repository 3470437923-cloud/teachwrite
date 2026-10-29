/**
 * macOS 伪装探针 —— 让整套测试在「假装是 macOS」的环境下跑一遍。
 *
 * 为什么需要它：`src/core/platform.ts` 的平台判定第一级就是 `process.platform`，
 * 而 Windows 开发机上它永远是 `win32`。于是**所有 macOS 专属分支在 Windows 上
 * 从未被执行过** —— 一旦有人在路径拼接里写死 `\`，Windows 测试全绿，
 * 到了 Mac 上却全线失败（这正是本项目改造前真实发生过的事）。
 *
 * 这个 setup 文件把 `process.platform` 改成 `darwin`，`PLATFORM` / `PATH_SEP`
 * 随之变成 macOS 的值，测试里用 `join()` 构造的期望值也跟着变 ——
 * 于是「macOS 上会挂的测试」在 Windows 上就能被抓住。
 *
 * 必须由 `vitest.macos-sim.config.ts` 通过 `setupFiles` 引入，
 * **且必须在被测模块 import 之前生效** —— 这就是它作为 setupFile 而不是
 * 普通 import 的原因（setupFiles 在测试文件加载前执行）。
 *
 * 用法（在项目根目录）：
 *     npm run test            # Windows 原生
 *     npm run test:macos-sim  # 伪装 macOS
 * 两条都必须全绿。
 */
Object.defineProperty(process, "platform", {
  value: "darwin",
  configurable: true,
  writable: true,
});
