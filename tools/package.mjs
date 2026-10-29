// 按本机平台调用打包脚本，避免 macOS/Linux 默认执行 PowerShell。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const command = process.platform === "win32" ? "powershell" : "bash";
const scriptArgs = process.platform === "win32"
  ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "tools/package.ps1"]
  : [process.platform === "darwin" ? "tools/package.sh" : "tools/package-linux.sh"];
const result = spawnSync(command, [...scriptArgs, ...args], { cwd: root, stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
