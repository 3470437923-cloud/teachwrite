# DeepCompose · macOS 使用指南

> 目标平台：**Apple Silicon（arm64）/ macOS**。
> 本文是**照着敲就能跑完**的操作步骤；「为什么」写在每步下面。
>
> **硬性前提：Windows 行为不得变化。** 本文所有改动都遵守这条 ——
> Windows 侧的分隔符、目录口径、打包开关、WebView 目标全部保持原值，
> 平台差异一律走 `src/core/platform.ts` 的运行时分支、
> Rust 的 `#[cfg(...)]`、或 `tauri.macos.conf.json`。
>
> 本目录是 `S:\DeepCompose` 的**移植副本**。原盘一个字没动。

---

## 0. 一句话现状

macOS 移植的核心源码改造**已完成并验证**（平台判定、路径分隔符、系统目录、
窗口外壳、外部命令、WebView 数据存储、构建目标、名称校验平台门控），
打包脚本与文档也已补齐。**测试在两个平台口径下都全绿**（见 §3）：

| 验证 | 结果 |
|---|---|
| `tsc --noEmit` | exit 0（无输出） |
| `vitest run`（Windows 口径） | **677 通过 / 2 跳过** |
| `vitest run --config vitest.macos-sim.config.ts`（macOS 口径） | **676 通过 / 3 跳过** |
| `cargo test --lib`（Rust 层） | **25 通过 / 0 失败** |
| 交付扫描器 | **BLOCK=0 / WARN=0** |

你在 Mac 上要做的：装环境 → `npm ci` → 跑测试 → `npm run tauri:dev` 看效果 →
`bash tools/package.sh` 出产物。

> ⚠️ **`node_modules/` 已在交付前删除**（那是 Windows 原生装的，87 MB）。
> Mac 上必须先 `npm ci`（`package-lock.json` 已锁定版本）。
> 千万不要从 Windows 侧拷 `node_modules` 过来 —— 里面有 `.node` 原生二进制和
> Windows 版 esbuild/rollup，Mac 上直接崩。
>
> 同理 `dist/` 与 `src-tauri/target/`（2.45 GB 的 Windows Rust 产物）也已删除。

---

## 1. 环境准备

### 1.1 Xcode 命令行工具（必需）

Tauri 在 macOS 上要链接系统框架（WebKit / AppKit / Security），
**必须有 Xcode 或至少 Command Line Tools**：

```bash
xcode-select --install
sudo xcodebuild -license accept
```

验证：

```bash
xcodebuild -version     # 期望 Xcode 16.x 或更高
clang --version
```

> 只装 Command Line Tools 通常就够（本项目不写 Swift/Objective-C）。
> 但若 `cargo build` 报找不到 SDK，就装完整 Xcode。

### 1.2 Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup target add aarch64-apple-darwin
```

验证：

```bash
rustc --version     # 期望 1.77 以上（Cargo.toml 的 rust-version = "1.77"）
cargo --version
```

### 1.3 Node.js

```bash
node --version      # 期望 20 LTS 或更高（本项目在 Node 24 上验证过前端构建）
npm --version
```

### 1.4 不需要装的东西（省你时间）

- **不需要 `brew install openssl`**。`src-tauri/Cargo.toml` 里 `reqwest` 用的是
  `features = ["json", "rustls-tls"], default-features = false` ——
  **纯 rustls，不依赖系统 OpenSSL**。arm64 上开箱即用。
- **不需要 Python / PyInstaller**。前端资产由 vite 打进 `dist/`，再由
  `tauri.conf.json` 的 `frontendDist` 内联进二进制。`tools/` 下的 Python 脚本
  只是开发期的 UI 审计探针（可选）。
- **不需要 Windows 侧的任何工具链。**

### 1.5 装依赖

```bash
cd <本项目目录>
npm ci        # 用 package-lock.json 锁定版本；npm install 也行
```

> ⚠️ **交付副本里没有 `node_modules/`** —— 那是 Windows 原生装的，已删除。
> 别从 Windows 侧拷过来：里面有 `.node` 原生二进制和 Windows 版 esbuild/rollup，
> Mac 上直接崩。必须在本机重新 `npm ci`。
>
> ⚠️ **`dist/` 和 `src-tauri/target/` 也已删除**（前者 5.5 MB，后者 **2.45 GB**）。
> 这两个都是可再生的产物，但删掉 `dist/` 有个**必须先知道的连锁后果** ——
> 见下面 §2.0。

---

## 2. 跑源码

### 2.0 ⚠️ 先读这条：`dist/` 不只是产物，它还是 Rust 侧的编译前提

`src-tauri/src/lib.rs` 里的 `tauri::generate_context!()` 是**过程宏**，
它在**编译期**读取 `tauri.conf.json` 的 `frontendDist`（即 `"../dist"`）
并**要求该路径真实存在**。所以：

```text
dist/ 不存在  →  cargo build / cargo test / cargo check 全部直接失败
                 报错：The `frontendDist` configuration is set to "../dist"
                       but this path doesn't exist
```

**这不影响 Mac**（`package.sh` 与 `tauri:dev` 都会先跑 `beforeBuildCommand`
= `npm run build` 把 `dist/` 生成出来），但如果你**先手动跑 `cargo test`**，
就会遇到这个报错、并误以为移植坏了。

**正确顺序**：

```bash
npm ci
npm run build      # ← 先生成 dist/
npm test           # 前端测试
npm run typecheck
cd src-tauri && cargo test    # 现在才能编 Rust
```

> 这条已在交付前**实测确认**：删掉 `dist/` 后 `cargo test --lib` 报
> `proc macro panicked … frontendDist … doesn't exist`；
> 跑完 `npm run build` 后同一命令 **25 passed / 0 failed**。
>
> （顺带：Windows 侧的 `dist/` 是提交前就删掉的，所以这不是「移植引入的坑」，
> 而是**任何干净检出都会遇到**的固有顺序要求。）

### 2.1 浏览器预览（最快，不需要 Rust）

```bash
npm run dev
```

然后开 <http://localhost:5183/preview.html?theme=dark>（或 `?theme=light`）。

`preview.html` 是 **dev-only 入口**：它加载 `src/preview/mockBackend.ts`，
用内存文件系统拦截 Tauri IPC，喂入示例作品/会话/配置，让界面在纯浏览器里完整跑起来。
它**不会进生产构建**（`vite build` 只打 `index.html`，产物里搜不到它的任何字符串）。

其它有用的查询参数：`?promo=1`（宣传片演示书 + 剧本化 SSE 回放）、
`?welcome=1`（首启欢迎弹窗）、`?fail=prefs`（故障注入）。

### 2.2 Tauri 开发模式（真实外壳）

```bash
npm run tauri:dev
```

它按 `tauri.conf.json` 的 `beforeDevCommand` 起 vite（固定端口 5183），
再编 Rust 并打开真实窗口。首次编译要几分钟（cargo 冷启动 + 全部依赖）。

macOS 上窗口走的是 `tauri.macos.conf.json` 覆盖后的形态：
`decorations: true` + `titleBarStyle: Overlay` + `hiddenTitle: true`
→ **原生红黄绿三键**叠在网页内容左上角（Windows 侧仍是 `decorations: false` 自绘窗控）。

> ⚠️ 已知问题：**交通灯与品牌 logo 会重叠**，见 §7 第 1 条。

---

## 3. 跑测试

```bash
npm test                 # 等价：node node_modules/vitest/vitest.mjs run
npm run test:macos-sim   # 把 process.platform 伪装成 darwin 再跑一遍全部测试
npm run typecheck        # tsc --noEmit
```

### 3.1 `test:macos-sim` 是什么

本仓库只有 Windows 机器能跑测试，而 macOS 的分隔符分支必须**在 Windows 上也能被验证**。
两个探针文件做这件事：

- `vitest.macos-sim.setup.ts` —— `setupFiles`，把 `process.platform` 伪装成 `"darwin"`
- `vitest.macos-sim.config.ts` —— 带 `setupFiles` 的 vitest 配置

`src/core/platform.ts` 的平台判定第一级就是 `process.platform`，
所以改掉它，`PLATFORM` / `PATH_SEP` / `IS_WINDOWS` 立刻变成 macOS 的值，
所有走平台分支的测试都会用 macOS 口径跑一遍。

**它验证不了什么（重要）**：`os.tmpdir()`、`path.join` 这类 **Node 内置模块**
在 vitest 加载 setup 之前就已经按真实平台初始化了，所以模拟下它们仍是 Windows 行为；
Rust 侧、WKWebView、Gatekeeper、真实的 `~/Library` 权限也一概验不到。
**真机项见 §6。**

### 3.2 实测结果（Windows 开发机，2026-10 本次改造后）

| 命令 | 结果 | 退出码 |
|---|---|---|
| `npm test` | 48 文件全过 · **677 passed \| 2 skipped (679)** | **0** |
| `npm run test:macos-sim` | 48 文件全过 · **676 passed \| 3 skipped (679)** | **0** |
| `npm run typecheck` | 无输出 | **0** |
| `cargo test --lib`（`src-tauri/`） | **25 passed \| 0 failed** | **0** |

> 改造前：Windows 661 全过；macOS 模拟 **17 个失败**（644 过 / 17 挂，6 个文件）。
> 那 17 个全部是**测试**把 Windows 分隔符硬编码进期望值，源码是对的（见 §5）。
>
> `cargo test --lib` 里包含本次新增的 **6 条 `fs::` 名称校验测试** ——
> 它们用 `valid_child_name_on(name, windows)` 显式参数版，
> 在 Windows 上把 **Windows 与 POSIX 两种口径都真跑一遍**
> （`cfg!(windows)` 是编译期内建宏，不这样拆就永远测不到 macOS 分支）。

### 3.3 skip 清单（全部来自平台限定，不是被删掉的用例）

**Windows 上 skip 2 条** —— 这是 macOS 专有语义，Windows 上无法验证：

| 用例 | 为什么 |
|---|---|
| `pathGuard > POSIX 上冒号是合法文件名字符（macOS 专有） > 根内文件名带冒号必须放行` | POSIX 上 `:` 是合法文件名字符，ADS 检查必须只属于 Windows；这条锁「macOS 上带冒号的文件名不得被误拒」 |
| `pathGuard > … > POSIX 没有盘符概念：C:file 只是普通文件名，按项目内相对路径放行` | 同上；POSIX 没有盘符，`C:file` 是普通文件名 |

**macOS 模拟下 skip 3 条** —— 这是 NTFS 专有语义，macOS 上根本不该跑
（`src/core/tools/pathGuard.ts` 的冒号检查已被 `IS_WINDOWS` 正确包住）：

| 用例 | 为什么 |
|---|---|
| `pathGuard > NTFS 备用数据流（ADS，Windows 专有） > 根内路径挂冒号尾巴也拒绝` | NTFS ADS 是 Windows 文件系统概念 |
| `pathGuard > … > 盘符相对写法 C:file 同样拒绝（会拼出含冒号的路径）` | 同上 |
| `pathGuard > … > 盘符本身的冒号（C:\…）不算 ADS` | 同上 |

**通过数说明**：Windows 677 通过（≥ 661，且比改造前多 16 条 —— 新增了
`tests/core/dirs.test.ts` 的跨平台双向用例），macOS 模拟 676 通过。
两边的 `通过 + skip` 都是 **679**，平台限定只换位置、不丢覆盖。

---

## 4. 构建

### 4.1 只要前端产物（快，不需要 Rust）

```bash
npm run build      # = tsc --noEmit && vite build
```

产物在 `dist/`。

### 4.2 出 macOS 应用（.app + .dmg）

```bash
npm run package:mac          # = bash tools/package.sh（完整流水线 + 产物收集 + 自检）
npm run tauri:build:mac      # = tauri build（只要 tauri 的打包，不做收集/自检）
npm run tauri:dev            # 开发模式
```

`tools/package.sh` 的步骤（对照 Windows 的 `tools/package.ps1`）：

```
[0/6] 停掉本仓库 bundle 里正在跑的实例（否则替换 .app 会失败）
[1/6] tsc --noEmit        ← 类型闸（B-2：打包链路必须先过类型检查）
[2/6] vite build          ← 前端产物
[3/6] tauri build         ← cargo 编译 + .app/.dmg 打包
[4/6] copy -> release/DeepCompose.app + release/*.dmg
[5/6] 桌面替身（Finder alias；--no-alias 可跳过）
[6/6] 产物自检（arch / 最低系统 / bundle id / 图标）+ Gatekeeper 说明
```

其它用法：

```bash
bash tools/package.sh --check        # 只跑类型闸 + 前端构建，不打包
bash tools/package.sh --skip-build   # 跳过构建，只重新收集已有产物
bash tools/package.sh --no-alias     # 不在桌面建替身
```

> **为什么 macOS 版第 3 步是 `tauri build` 而不是裸 `cargo build --release`**：
> Windows 的交付物是**单文件 exe**，裸 cargo 产物拷出来就能用；
> macOS 的交付物是 **`.app` 包**（`Info.plist` / 图标 / 签名结构都在包里），
> 只有 tauri 的 bundler 会生成它。裸 cargo 产物
> `src-tauri/target/release/deepcompose` 是个裸 Mach-O 可执行文件，
> 拖进 `/Applications` 不是可用的应用。

### 4.3 `.app` 产物位置

| 产物 | 路径 |
|---|---|
| `.app`（bundler 原始输出） | `src-tauri/target/release/bundle/macos/DeepCompose.app` |
| `.dmg` | `src-tauri/target/release/bundle/dmg/DeepCompose_<版本>_<架构>.dmg` |
| `.app`（收集副本） | `release/DeepCompose.app` |
| `.dmg`（收集副本） | `release/DeepCompose_<版本>_<架构>.dmg` |

装到「应用程序」：把 `DeepCompose.app` 拖进 `/Applications`。
想放进启动台/程序坞就再从那里拖一次。

`bundle.targets` 在 macOS 上是 `["app", "dmg"]`（Windows 上是 `["nsis"]`），
由 `src-tauri/tauri.macos.conf.json` 覆盖 —— Tauri 2 **自动合并**该文件，不需要 `--config`。

### 4.4 Gatekeeper / quarantine

本次移植**不含签名与公证**。产物分两种情况：

1. **本机刚构建出来的**（`release/` 下）：没有 quarantine 标记，双击即可打开。

2. **经浏览器/邮件/聊天工具传到这台 Mac 的**（尤其 `.dmg` 里的）：会被打上
   `com.apple.quarantine`，首次打开报「无法打开，因为 Apple 无法检查它是否包含恶意软件」。

   两种解法，任选其一：

   - Finder 里 **右键 →「打开」→ 再点「打开」**（只需一次，之后正常）
   - 命令行去掉隔离标记：
     ```bash
     xattr -dr com.apple.quarantine "release/DeepCompose.app"
     # 已装到 /Applications 的：
     xattr -dr com.apple.quarantine "/Applications/DeepCompose.app"
     ```

想分发给别人（不受此拦截）需要 Apple Developer 账号做
`codesign` + `notarytool` + `stapler`，并配置 `tauri.conf.json` 的
`bundle.macOS.signingIdentity` —— **本次范围之外**。

### 4.5 数据落在哪里（macOS 口径）

| 内容 | 路径 |
|---|---|
| 作品根（默认） | `~/AI写小说/<书名>/` |
| 章节正文 | `~/AI写小说/<书名>/章节内容/第N章.md` |
| 资料文档 | `~/AI写小说/<书名>/小说资料/*.md` |
| 候选稿 | `~/AI写小说/<书名>/待确认/`（已处理在 `待确认/已处理/`） |
| 回收站 | `~/AI写小说/.openwrite_recycle/` |
| 会话 / 快照 | `~/Documents/writerd_sessions/` · `~/Documents/writerd_snapshots/` |
| 备忘录 / 快捷提示词 | `~/Documents/writerd_memos.json` · `~/Documents/writerd_quick_prompts.json` |
| 内置技能 | `~/Documents/skills/` |
| 配置 | `~/Library/Application Support/com.writerd/writerD/shared_preferences.json` |
| 用量统计 / 窗口几何 | `…/com.writerd/writerD/usage_stats.json` · `window_state.json` |
| 诊断日志 | `…/com.writerd/writerD/diagnostics/diagnostic.log` |
| 网页版参考栏数据 | 系统 WebKit 数据存储（标识由 key 推导，**不在**配置目录里） |

> 中文目录名（`小说资料` / `章节内容` / `待确认` / `已处理` / `审核` / `个人改稿`）
> 与 `com.writerd` / `writerD` / `shared_preferences.json` / `writerd_*` 前缀
> 都是**磁盘冻结名**，跨平台逐字相同 —— 任何重构都不许改。

---

## 5. 本次改造的逐项清单

### 5.1 新增文件

| 文件 | 作用 |
|---|---|
| `src/core/platform.ts` | **平台判定唯一真源**：`process.platform` → `navigator.userAgent` → 兜底 Windows。导出 `PLATFORM` / `IS_WINDOWS` / `IS_MACOS` / `PATH_SEP` / `applyPlatformAttribute` |
| `src-tauri/tauri.macos.conf.json` | macOS 侧配置覆盖：`decorations:true` + `titleBarStyle:Overlay` + `hiddenTitle` + `trafficLightPosition` + `"label":"main"`，`bundle.targets:["app","dmg"]` |
| `tools/package.sh` | macOS 打包流水线（`package.ps1` 的等价物） |
| `tests/core/dirs.test.ts` | 路径权威的**跨平台双向**回归锁（见 5.4） |
| `vitest.macos-sim.setup.ts` · `vitest.macos-sim.config.ts` | macOS 平台模拟探针（`npm run test:macos-sim`）—— **永久保留的回归工具**，不是一次性脚本 |
| `README-macOS.md` | 本文 |

### 5.2 源码改造（相对 Windows 版）

| 位置 | 原写法 | 现写法 | 为什么 |
|---|---|---|---|
| `src/core/dirs.ts` | 到处硬编码 `\` 拼接 | 分隔符一律来自 `PATH_SEP`；新增显式分隔符版本 `joinWith(sep,…)` / `relativeWith(sep,…)`；`isDriveRoot(path, windows)` 收显式平台参数 | 让 macOS 拼法**在 Windows 上也能被测试** |
| `src/core/dirs.ts` 的 `join` | 无平台意识 | 首段以 `/` 开头时**无条件**用 `/` | Rust 递过来的 `/Users/…` 若被拼成 `/Users/me\AI写小说`，在 POSIX 上是**单个目录名**，`create_dir_all` 会建出带反斜杠的怪目录，全部派生路径同时失效 |
| `src/core/tools/pathGuard.ts` | 输入侧不归一分隔符；冒号（ADS）检查无条件 | `unifySep` 把两种分隔符都归一到**本机**；`normalizeForCompare` 输出本机分隔符；ADS 检查用 `IS_WINDOWS` 包住 | ① 模型会把 `file_read(list)` 回报的 `章节内容\第1章.md` 原样回传成 `path` 参数，macOS 上 `\` 是**合法文件名字符**，不归一就读不到；② `isInside` 的边界前缀匹配必须用本机分隔符，否则根内路径被整批误拒；③ POSIX 上 `:` 合法，ADS 检查外溢会误拒正常文件名 |
| `src/core/tools/exec.ts` | 注释与实现不一致 | `file_read(list)` 条目 `path` 与 `file_manage(search)` 的 `file` 用**本机**分隔符（项目根相对）；其余 `path` 字段一律 `/`（`slashPath`） | 前者是模型要回传的协议格式，后者是既有实测样本（1,729 条） |
| `src-tauri/src/sys.rs` | `USERPROFILE` / `APPDATA` / `home\Documents` 硬编码；`open_dir` 用 `explorer`；`open_url` 用 `cmd /C start` | 非 Windows 走 tauri 的 path API：`$HOME`、`~/Library/Application Support`、`~/Documents`；`open_dir` → macOS `open`、其它 unix `xdg-open`；`open_url` → `open` | ① macOS 上没有 `explorer` / `cmd`，照旧写法这两个入口**永久失败**；② **绝不**回退到 `current_exe().parent()` —— 那在 macOS 上是 `…/DeepCompose.app/Contents/MacOS/`，即**应用包内部**，写进去会破坏代码签名 |
| `src-tauri/src/winstate.rs` | `state_path()` 无参；尺寸补偿循环无条件跑 | `state_path(app)` 走 `sys::prefs_path`；`correct_size` 加 `#[cfg(windows)]`，非 Windows 是空实现 | 那段补偿是为 `WS_CAPTION`（Windows 专有）的首次 `set_size` 偏差写的；macOS 上跑它只会白等 3×60ms 再 `show()`，把启动显示推迟约 180ms |
| `src-tauri/src/web.rs` | 只用 `data_directory` 做子 webview 的存储隔离 | 同时挂 `data_directory` **和** `data_store_identifier` | wry 只在 Windows(WebView2)/Linux(webkitgtk) 实现 `data_directory`，**macOS 上静默无效**（wkwebview 根本没读它）→ 登录态与主窗口共用同一个 store。`data_store_identifier`（`WKWebsiteDataStore::dataStoreForIdentifier`）是官方替代品 |
| `vite.config.ts` | `build.target: "chrome110"` | 平台分流：**darwin → `safari16`**，其余（含 Windows）保持 `chrome110` | macOS 的 WebView 是 **WKWebView（Safari 内核）**，不是 Chromium。实测同一份源码只改 `--target` 的唯一差别：`chrome110` 的 CSS 里 `-webkit-user-select` 出现 **0 次**，`safari16` 出现 **8 次**（JS 产物逐字节相同）。而 `user-select` 的无前缀形式在 Safari 上**至今不支持**（web-features：Safari "Not supported"）→ 缺前缀会让 `body` / `input,textarea,select` 上的 `user-select` 规则整条失效 |
| `src/preview/mockBackend.ts` | `const HOME = "C:\\Users\\Preview"` | 值不变，**加注释说明为什么可以保留** | 它只被 `src/preview/main.tsx` 引用，而 `preview.html` 是 dev-only 入口，生产构建只打 `index.html` → 这个文件不进 Tauri 产物（已实测：产物 JS 里搜不到 `Users\Preview`）。夹具里的 `\` 与 mock 的 `norm()` 口径一致 |
| `package.json` | 只有 Windows 侧脚本 | 补 `test:macos-sim` / `package:mac` / `tauri:build:mac` | Windows 脚本**一条没删**：`package` 仍指向 `package.ps1`，`tauri:build` 仍是 `tauri build` |
| `src-tauri/src/fs.rs` | `valid_child_name` 无条件拒绝 `\ : * ? " < > \|` 与 Windows 保留设备名 | 拆成两层：`valid_child_name(name)` 按本机平台分派 → `valid_child_name_on(name, windows)` 显式平台参数；`/` 与 NUL 两平台都拒，Windows 专有那一组包进 `if windows` | ① TS 层 `pathGuard` 的冒号检查**已被 `IS_WINDOWS` 正确包住**，所以 macOS 上 `file_write` 允许写 `第1章:初稿.md` —— Rust 层若无条件拒绝，用户就**建得出来、删不掉**；② `cfg!(windows)` 是**编译期内建宏**，不拆成显式参数的话 macOS 分支在 Windows 开发机上**永远跑不到、也永远测不了** |
| `tools/b19_probe.py` | `SHOTS = r"S:\deepcompose\shots"` | 从**脚本自身位置**推导项目根（`tools/` 的上一级）的 `shots/`，可用环境变量 `DC_SHOTS` 覆盖 | 那是开发机路径，Mac 上没有 `S:` 盘，`os.makedirs` 直接抛 `FileNotFoundError`，整个探针跑不起来 |
| `tools/_compare_sheet.py` | 字体候选只有 `C:\Windows\Fonts` 和 `/usr/share/fonts/truetype/dejavu` | 追加 macOS 候选：`/System/Library/Fonts`(+`Supplemental`)、`/Library/Fonts` 下的 PingFang / Hiragino Sans GB / STHeiti Medium / Songti / Arial Unicode | 原来的第二个候选是 **Linux** 路径，macOS 上不存在 → 中文标题会渲染成方块。macOS 候选都是系统自带，无需安装 |

**未改动的关键文件**（Windows 行为逐字保持）：`src-tauri/src/lib.rs`、
`src-tauri/src/ai.rs`、`src-tauri/Cargo.toml`、
`src-tauri/icons/**`（`icon.icns` 是新增的，其余图标逐字节未变）。

### 5.3 配置改造

| 位置 | 改动 |
|---|---|
| `tauri.conf.json` → `bundle.icon` | 加入 `icons/icon.icns`（973,942 字节，已存在）—— Windows 的 `icon.ico` 保持不变 |
| `tauri.conf.json` → `bundle.macOS` | `minimumSystemVersion: "14.0"`（见 §7 第 3 条）、`hardenedRuntime: false`、`entitlements: null`、`dmg` 窗口布局 |
| `tauri.conf.json` → 窗口 | 加 `dragDropEnabled: true`（两平台都要）**+ `"label": "main"`**（见 §7 第 4 条） |
| `tauri.macos.conf.json` | 覆盖 `bundle.targets` → `["app","dmg"]`；窗口改 `decorations:true` + `titleBarStyle:"Overlay"` + `hiddenTitle:true` + `trafficLightPosition:{x:13,y:23}` **+ `"label": "main"`** |

> **Tauri 2 的平台配置合并是 RFC 7396（JSON Merge Patch）语义，数组是整体替换。**
> 所以 `tauri.macos.conf.json` 里的 `app.windows[0]` **必须重写每一个字段**，
> 漏掉的字段会退回**默认值**而不是继承 `tauri.conf.json` 的值。
> 改窗口字段时**两个文件都要改**。
>
> 所有用到的键都已对着 `node_modules/@tauri-apps/cli/config.schema.json`
> （tauri 2.12）核过：`BundleType` 枚举含 `app`/`dmg`；`TitleBarStyle` 枚举含
> `Overlay`；`trafficLightPosition` 的 schema 明确要求
> `titleBarStyle: Overlay` **且** `decorations: true`（两边都满足）；
> `MacConfig` 含 `minimumSystemVersion`/`hardenedRuntime`/`entitlements`/`dmg`。

### 5.4 测试改造

改造原则：**源码是对的，问题在测试**。测试把 Windows 分隔符硬编码进了期望值，
而改造后的源码会按 `PATH_SEP` 正确地产出 `/`。所以只改 `tests/`，
**没有为了过测试而放宽任何源码**。

| 文件 | 改法 |
|---|---|
| `tests/tools/pathGuard.test.ts` | 期望值改用被测代码自己的 `join` 构造；ADS 那组用 `describe.runIf(IS_WINDOWS)` 限定；**新增** macOS 专有互补组（`runIf(!IS_WINDOWS)`）锁「带冒号的文件名必须放行」；把与平台无关的 `resolveToolPath` 用例移出 ADS 组 |
| `tests/core/skillsBuiltin.test.ts` | 技能根只是**输入夹具**，落盘键期望值一律用 `join(SKILLS, …)` 构造；`writeText` 故障注入的路径判断从 `"\\alpha\\"` 改成 `PATH_SEP + "alpha" + PATH_SEP` |
| `tests/store/project.test.ts` | `rel` 期望值改用 `join(...)` 构造（4 处） |
| `tests/store/snapshot.test.ts` | `snapshotFile` 期望值改用 `join(DIR, "abc-123.json")` |
| `tests/ai/controller.test.ts` | 落盘路径前缀断言从 `sessionsDir + "\\"` 改成 `sessionsDir + PATH_SEP` |
| `tests/tools/exec.test.ts` | `list` 条目 `path` / `search` 的 `file` 期望值改用 `join(...)`；授权拒绝文案的路径断言按 `PATH_SEP` 归一后再比 |
| `tests/core/dirs.test.ts` | **新增**。`joinWith` / `relativeWith` 对 `"/"` 与 `"\\"` **各测一遍**，`join` 的 POSIX 绝对路径防御、`basename`/`dirname`/`isDriveRoot` 双分隔符、以及 `resolveDirs` 的 **macOS 目录布局**（`~/Documents`、`~/Library/Application Support`、`~/AI写小说`）—— 后者在 Windows 上也成立，因为 `join` 见到 `/` 开头就无条件用 `/` |
| `src-tauri/src/fs.rs` 的 `mod tests` | **改造成平台感知**。5 条既有用例改为经 `valid_child_name_on(name, windows)` **两平台各跑一遍**；新增 `rejects_ads_and_wildcards_on_windows_only` / `rejects_reserved_device_names_on_windows_only` 的 POSIX 互补断言；**新增回归锁** `valid_child_name_follows_the_host_platform` 确认 `valid_child_name` 真按本机平台分派（防止 `cfg!(windows)` 被写反） |

> **这套 Rust 测试当场就抓到一个我写错的预期值**：`..\..` 看起来像
> 「POSIX 上该放行」（因为 `\` 在 POSIX 上合法），实际**两平台都拒** ——
> Windows 因为含 `\`，POSIX 因为"以点结尾"这条命名约定。
> 已把这条差别单独写成用例钉住，而不是把断言改松。

---

## 6. 待 Mac 真机验证的清单

在 Windows 上**无法**验证、必须到 Mac 上实测的（按重要性排序）：

1. **✅ 交通灯与品牌 logo 的重叠已在源码层面修好** —— 见 §7 第 1 条。
   自绘窗控已在 macOS 上隐藏、标题栏左内边距已留出 78px。
   **仍需目视确认留白是否协调**（若偏大/偏小只改 `app.css` 里那一个数值）。
2. **`.app` 能否双击启动** —— 首次编译后确认窗口出现、无「已损坏」提示。
3. **`cargo build` 在 aarch64-apple-darwin 上是否顺利** —— 尤其
   `reqwest` + rustls 与 `tauri` 的 `unstable`（multiwebview）特性。
   > Windows 侧已实测 `cargo test --lib` 通过（25 个测试），
   > 但**交叉编译到 aarch64 只能在 Mac 上做**。
4. **`~/Library/Application Support/com.writerd/writerD/` 是否真的被创建**，
   且 `shared_preferences.json` 落在这里（而不是落进 `.app` 包内）。
5. **`~/AI写小说` 作品根的读写** —— 建书、写章节、资料文档、回收站、
   `.openwrite_manifest.json` 是否都在预期位置。
6. **中文文件名在 APFS 上的表现** —— macOS 用 **NFD** 归一化（Windows 用 NFC）。
   本项目目录名与文件名都是中文，中文无规范分解，**理论安全**；
   但要实测「建书 → 重启 → 目录树仍在」「回收站清单仍能对上」。
   > 注意：`pathGuard` 的比较是大小写不敏感的（macOS 默认 APFS 卷也是），
   > 但如果把作品根放到**大小写敏感**的 APFS 卷上，会有一批路径判定行为变化。
7. **`open_dir`（设置页「打开目录」）与 `open_url`（关于页作者主页）** ——
   确认分别拉起 Finder 与默认浏览器。
8. **网页版参考栏的存储隔离** —— `docs/DEVELOPMENT.md` 写的
   「删掉 `webview-sessions\{deepseek,zhuque}` = 网页版退出登录」在 macOS 上
   **不再成立**（`data_directory` 无效），改走 `data_store_identifier`。
   确认：两个栏各自独立登录、重启后登录态保留、两个栏之间互不串号。
   > 该 API 需要 **macOS 14+**（wry 有 `os_major_version >= 14` 守卫，
   > 13.x 上会**静默退回共享 store**、不崩）。
   > `minimumSystemVersion` 已因此提到 `"14.0"`，见 §7 第 3 条。
9. **窗口几何记忆** —— 关闭再打开，位置/尺寸/最大化状态是否还原
   （`window_state.json` 落在配置目录）。
10. **`titleBarStyle: Overlay` 下的拖拽与双击最大化** —— 自绘标题栏的
    `onMouseDown → startDragging` 与 `onDoubleClick → toggleMaximize` 在
    WKWebView 里的行为（`user-select` 前缀修好之后，拖拽时不应再选中文字）。
11. **`.dmg` 的窗口布局** —— `bundle.macOS.dmg` 里的
    `windowSize 660×400` / `appPosition` / `applicationFolderPosition` 是否合适。
12. **`tools/package.sh` 在真 bash 下的行为** —— 已用 Git Bash 通过 `bash -n`
    与 `--help` / `--check` 实测（见 §7 第 6 条），但 `osascript` 建替身、
    `lipo`/`PlistBuddy` 自检、`pgrep -f` 杀进程这三段**只能在 Mac 上跑**。
13. **字体渲染差异** —— 界面用的是内嵌 MiSans / Inter（woff2），
    理论上两平台一致；但 WKWebView 的字形回退与子像素渲染与 Windows 不同，
    排版宽度可能有 1–2px 级差异。截图对比一次即可。
14. **`safari16` 构建目标下的 CSS 是否完整** —— 已确认 `-webkit-user-select`
    被补上（8 处），但 `color-mix()`（27 处）esbuild **降不了**（参数含 `var()`），
    需要 **Safari 16.2+**。这也是把最低系统提到 `14.0` 的理由之一，见 §7 第 3 条。
15. **`file_write` 能建、`fs_remove_child` 能删（含 `:` 等字符的名字）** ——
    见 §7 第 2 条。逻辑已按平台门控并有 Rust 单元测试覆盖，
    但**真机上确认一次**更稳妥：在 macOS 上建一个名叫 `测试:冒号.md` 的文件，
    然后删掉它，应当**两步都成功**。

---

## 7. 本次发现并处理的问题

### 1. ✅ macOS 标题栏：交通灯压住品牌 logo（**已修**）

**问题**（上一轮改造留下的缺口）：

- `src/main.tsx:18-21` 的注释写着「平台标记必须在首帧之前落到 `<html>`：
  CSS 要靠它决定标题栏左内边距」，代码也真的调了 `applyPlatformAttribute(...)`；
- **但全仓库没有任何一条 CSS 消费 `data-os`** —— 那个属性当时是个没人读的摆设
  （属于「看着像做了、其实没生效」的那类缺口）；
- `src/ui/MainWorkbench.tsx` 里的自绘窗控（最小化/最大化/关闭）**无条件渲染**，
  而 macOS 上窗口是 `decorations: true`，于是会出现**两套窗控**；
- 数值上也确实重叠：`.titlebar` 是 `padding: 0 8px 0 13px`（品牌从 x=13 开始），
  `trafficLightPosition` 也是 `{x: 13}` —— 交通灯同样从 x=13 开始。

**修法**（三处）：

1. `src/ui/MainWorkbench.tsx` + `src/screens/SettingsScreen.tsx`：
   把「分隔线 + 最小化 + 最大化 + 关闭」包进 `<span className="win-ctrls">`。
   **只包这三个** —— `.win-tools` 里还有设置按钮和网页栏两个开关，必须留着。
2. `src/styles/app.css`：
   ```css
   .win-ctrls { display: contents; }                        /* 包裹层不改变原 flex 布局 */
   html[data-os="macos"] .win-ctrls { display: none; }       /* 藏掉自绘窗控 */
   html[data-os="macos"] .titlebar { padding-left: 78px; }   /* 给原生三键让位 */
   ```
   78px = `trafficLightPosition.x`(13) + 三键总宽(约 52) + 留白(13)。
   **改 `trafficLightPosition` 时这条要跟着改**（两处已在注释里互相引用）。
3. 已在产物 CSS 里实测确认两条规则都进了包：
   `html[data-os=macos] .win-ctrls{display:none}` 与
   `html[data-os=macos] .titlebar{padding-left:78px}`。

**仍需目视微调**：78px 是按交通灯标准宽度算的，**实际留白是否协调要看屏幕**。
若偏大/偏小，只改 `app.css` 里那一个数值即可，不涉及逻辑。

### 2. ✅ `src-tauri/src/fs.rs` 的名称校验在 macOS 上会误拒合法文件名（**已修**）

`valid_child_name()`（被 `fs_remove_child` 调用）原先**无条件**拒绝
`\ / : * ? " < > |` 以及 Windows 保留设备名（`CON` / `PRN` / `AUX` / `NUL` / `COM1-9` / `LPT1-9`）。

在 POSIX 上只有 `/` 和 NUL 是非法字符，其余全都合法。于是出现**不对称**：

- TS 层（`pathGuard.ts`）的冒号检查**已经被 `IS_WINDOWS` 正确包住**，
  所以 macOS 上 `file_write` **允许**写一个名叫 `第1章:初稿.md` 的文件；
- Rust 层 `fs_remove_child` 却**拒绝**删除它 → **用户建得出来、删不掉**。

同一个坑也覆盖 `*` `?` `"` `<` `>` `|` 与设备名（`NUL.md` 在 macOS 上是正常文件）。

**修法**：按平台门控，`/` 与 NUL 在所有平台都拒，Windows 专有的那一组
（`\ : * ? " < > |` + 保留设备名）包进 `windows` 参数。
「不以空格或点结尾」保留为**跨平台命名约定**（不是平台限制，
而是避免跨平台同步时出现同名不同实体的两份文件）。

> ★ **关键做法：`cfg!(windows)` 是编译期内建宏，Windows 开发机上无法翻转** ——
> 也就是说 macOS 分支**永远不会被执行，也就永远无法被测试**。
> 所以把它拆成两层：
>
> ```rust
> pub fn valid_child_name(name: &str) -> Result<(), String> {
>     valid_child_name_on(name, cfg!(windows))   // 运行时按本机平台分派
> }
> pub fn valid_child_name_on(name: &str, windows: bool) -> Result<(), String> { … }
> ```
>
> 平台做成**显式参数**后，单元测试就能在 Windows 上把**两种口径都真跑一遍** ——
> 而不是只写一句没有证据的断言。另加一条回归锁
> `valid_child_name_follows_the_host_platform`，防止将来有人把
> `cfg!(windows)` 写反（写成 `!cfg!(windows)`）却没人发现。
>
> **实测结果**（`cargo test --lib`）：**25 passed / 0 failed**。
> 期间这套测试还真的抓到过一个我自己写错的预期值
> （`..\..` 看起来像「POSIX 上该放行」，实际**两平台都拒** ——
> Windows 因为含 `\`，POSIX 因为"以点结尾"这条约定），
> 已把这条差别单独写成用例钉住。

> 这是**移植前就存在**的问题（`fs.rs` 不在上一轮改造的 diff 里），
> 但它是 macOS 上会真实咬人的一类。

### 3. ✅ `minimumSystemVersion` 声明得比实际需要低（**已修正**）

原值是 **`"13.0"`**（Ventura 首发，自带 Safari 16.1），但实际需要更高：

- **`color-mix()` 需要 Safari 16.2+**（= macOS 13.1）。本项目 CSS 里有 **27 处**
  `color-mix()`，`--accent-2` / `--accent-text` / `--accent-soft` / `--accent-line` /
  `--accent-fill` / `--selected` / `--focus-halo` 这些变量全靠它派生。
  在 macOS 13.0 上这些声明会在 computed-value 阶段失效 →
  **强调色与选中态会明显不对**。esbuild 降不了它们
  （参数里含 `var()`，无法在构建期求值），改 `build.target` 没用。
- **`data_store_identifier` 需要 macOS 14+**。wry 有版本守卫
  （`os_major_version >= 14`，见 `wry-0.57.0/src/wkwebview/mod.rs:224`），
  13.x 上会**静默退回共享 store**（不崩，但网页版参考栏的登录态隔离失效）。
- `web.rs` 的文件头注释自己写着「本产品目标 macOS 26」。

**已改为 `"14.0"`。** 理由：声明一个低于实际需要的版本会让应用
**装得上却表现不对**（强调色错、隔离失效），比直接拒绝安装更糟。
目标机是 macOS 26，本改动对它是零影响。

> **若将来要支持 macOS 13.x**：把这一行降到 `"13.1"`（color-mix 可用），
> 并接受「网页版参考栏两个站点共用同一 WebKit 存储、登录态可能串号」；
> 降到 `"13.0"` 则强调色也会坏。**这是唯一一处需要你确认的支持范围取舍**，
> 已在第五节 P2 列出。

### 4. ✅ `tauri.conf.json` 的窗口没有显式 `label`（**已补**）

`src-tauri/capabilities/default.json` 写的是 `"windows": ["main"]`，
而 `web.rs` 又硬取 `app.get_window("main")` —— 两处都依赖「窗口标签默认是 `main`」
这个**隐式约定**。当前是对的（Tauri 的默认标签就是 `main`），
但一旦有人在窗口配置里加了别的字段或顺序，这个约定就可能悄悄失效，
表现为**窗口命令全被 ACL 拒绝**。

已在 `tauri.conf.json` 与 `tauri.macos.conf.json` **两份里都显式写上
`"label": "main"`**，把这个约定钉死（与同批次的 `04_师作TeachDo` 一致）。

### 5. `release/DeepCompose.exe` 是 Windows 产物，macOS 上不需要

`release/DeepCompose.exe`（10,120,192 字节）是 **Windows 交付产物**，
已被 git 追踪，所以**照原样带进了副本**（SHA256 与源盘逐字节一致），
以保持副本的 git 状态与源盘一致 —— 避免出现「文件被删了」的误导性 diff。

**macOS 上不需要它**，也**不要**用它：macOS 的交付物是
`release/DeepCompose.app`（由 `tools/package.sh` 产出）。
这个 `.exe` 在 Mac 上只是个 10 MB 的占位文件，可随时删除。

> 顺带一提：`.gitignore` 没有忽略 `release/`，而 `tools/package.sh` / `package.ps1`
> 都会往那里写产物。**没有擅自改 `.gitignore`** —— 那是版本管理策略。
> 建议你自己决定是否加一行 `release/`。

### 6. `tools/package.sh` 的验证边界

已在 Windows 上用 Git Bash 实测通过：

- `bash -n tools/package.sh` → exit 0（语法）
- `bash tools/package.sh --help` → exit 0（打印文件头说明）
- `bash tools/package.sh --bogus` → exit 2（参数校验）
- `bash tools/package.sh --check` → exit 0（真的跑完了 `tsc --noEmit` + `vite build`）
- 行尾是 **LF**、无 BOM（Windows 上写的脚本如果带 CRLF，Mac 上会报
  `bad interpreter: No such file or directory`）

**没验证到的**：`[3/6] tauri build`（需要 Rust 冷编译）、
`[5/6] osascript` 建替身、`[6/6]` 的 `lipo` / `PlistBuddy` 自检、
`[0/6]` 的 `pgrep -f` 杀进程。这四段只能在 Mac 上跑。

---

## 8. 一句话

**Windows 侧的路径口径、目录布局、打包开关、WebView 目标一个字没动**；
改的全是「按平台分流」的那一层。测试在两个平台口径下都全绿，
剩下的是 §6 的真机验证清单。

> **唯一需要你拍板的**：`minimumSystemVersion` 现在是 `"14.0"`。
> 若你还有 macOS 13.x 的机器要用这个软件，见 §7 第 3 条的取舍说明。
