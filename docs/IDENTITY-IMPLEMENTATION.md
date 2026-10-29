# TeachWrite 身份与应用数据隔离实现

本记录只覆盖身份、应用数据目录、原生配置、平台打包与 CI。原 DeepCompose 项目未被本实现编辑；未提交代码。作者 Liumorrow、版权年份、社群信息及 GPL-3.0-only 许可保留。

## 身份

- 产品名和窗口标题：TeachWrite。
- npm 包：teachwrite，版本 0.1.0。
- Rust package / lib：teachwrite / teachwrite_lib，版本 0.1.0。
- Tauri identifier：com.teachwrite.desktop。
- Rust app_info 返回 TeachWrite；构建烙印由 TW_BUILD_COMMIT / TW_BUILD_TIME 注入。
- Cargo.lock 只更新本地应用 package 的身份，依赖版本保持原值。

## 数据契约

TS resolveDirs 和 Rust prefs_path 使用相同的应用身份段 com.teachwrite.desktop。所有应用数据默认从以下根推导：

| 平台 | 应用根 |
| --- | --- |
| Windows | %APPDATA%/com.teachwrite.desktop |
| macOS | ~/Library/Application Support/com.teachwrite.desktop |
| Linux | 系统 data_dir()/com.teachwrite.desktop，通常为 $XDG_DATA_HOME/com.teachwrite.desktop 或 ~/.local/share/com.teachwrite.desktop |

同一应用根下保存 shared_preferences.json、window_state.json、writerd_sessions/、writerd_snapshots/、writerd_memos.json、skills/、writerd_quick_prompts.json、usage_stats.json 和 diagnostics/diagnostic.log。保留叶名是为了沿用存储格式；应用根负责隔离。

不读取、不复制、不迁移 DeepCompose 的 com.writerd/writerD 配置，也不读取 Documents 顶层旧应用数据。新配置中没有旧的自定义路径覆盖项；作者后续主动设置的技能目录仍可覆盖默认位置。

默认作品根保留 ~/AI写小说（Windows 对应用户主目录），由主 agent 确认，避免主动搬书。作品内 小说资料/、章节内容/、待确认/、已处理/、审核/、个人改稿/、writerd_oplog/、.openwrite_manifest.json、.openwrite_recycle/ 等冻结名不变。应用数据隔离不等于复制或隔离作者主动打开的作品。

Linux 的系统数据目录兜底现使用绝对 XDG_DATA_HOME 或 ~/.local/share；打开链接使用 xdg-open。macOS 继续使用 open，Windows 继续使用系统原有分支。窗口状态通过 prefs_path 的同级文件推导，因此自动进入独立根。

## 打包与 CI

- npm run package 通过 tools/package.mjs 按本机平台选择脚本；也可使用 package:windows、package:mac、package:linux。
- Windows：TeachWrite.exe / TeachWrite.lnk；只处理此 checkout 下的 TeachWrite 进程和产物，不再删除 writerD / KeepCompose 的快捷方式。Tauri 默认产物为 NSIS 安装包。
- macOS：TeachWrite.app / DMG，macOS overlay 配置自动合并；本地脚本支持 --check、--skip-build、--no-alias。最低系统版本沿用 14.0。
- Linux：tauri.linux.conf.json 自动合并，构建 deb / AppImage；package-linux.sh 收集产物到 release/。
- 所有 Cargo 构建使用 --locked；Tauri 通过自身参数分隔符把该参数传给 Cargo。
- .github/workflows/desktop.yml 使用 macos-14、windows-latest、ubuntu-22.04 矩阵；npm ci → 前端类型检查与构建 → Vitest → Rust 单测 → 原生打包 → 上传各平台安装包。Linux 安装 WebKitGTK 4.1 等系统依赖。
- 主 agent 授权生成 package-lock.json，CI 据此使用 npm ci。未加入新运行时依赖。

## 本次验证

- node_modules/.bin/vitest run tests/core/dirs.test.ts：17/17 通过，包含 Windows/macOS 目录契约和 Linux 独立根回归。
- npm run typecheck：exit 0。
- npm run build：exit 0；保留已有 prefs.ts 动态/静态导入混用警告。
- cargo metadata --locked --no-deps --format-version 1：exit 0，确认 teachwrite / teachwrite_lib / 0.1.0。
- cargo test --lib --locked：25/25 通过。首次因 dist 缺失失败；完成前端构建后重跑通过，无需改变测试或降低检查。
- bash -n tools/package.sh tools/package-linux.sh、node --check tools/package.mjs：exit 0。
- macOS release app 打包实际尝试：修正 Tauri/Cargo 参数传递后，beforeBuildCommand 的类型检查因并行开发中的 tests/teaching/guide.test.ts 引用尚未落盘的 src/core/teaching/guide 失败（TS2307，exit 1），未进入 release 编译；由主 agent 待教学模块完成后重跑。不能声称 macOS release 包已验证。
- Windows/Linux 原生构建、安装器运行、实际系统目录 I/O、GitHub Actions 远程执行均未在本机运行，不能据跨平台路径单测声称真实平台验收完成。
- 全量 Vitest 由主 agent 负责；本子任务未修改 dirs 以外的测试文件。

生成依赖锁后 npm audit 返回 1 项既有间接开发依赖告警：source-map-js 1.2.1，GHSA-68fv-2mgg-jv7q（indexed sourcemap offset 可导致事件循环 DoS）。本任务未升级该依赖，未把依赖审计宣称为通过。
