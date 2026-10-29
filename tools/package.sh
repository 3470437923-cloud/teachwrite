#!/usr/bin/env bash
#
# Build TeachWrite end to end on macOS and refresh the delivery artifacts.
#
# macOS 版的 tools/package.ps1 等价物，逐条对应：
#
#   package.ps1 (Windows)                     package.sh (macOS)
#   --------------------------------------    --------------------------------------
#   [0/5] 杀掉占用产物的旧进程                 [0/6] 同左（只杀本仓库 bundle 里的进程）
#   [1/5] tsc --noEmit（类型闸）              [1/6] 同左
#   [2/5] vite build                          [2/6] 同左
#   [3/5] cargo build --release               [3/6] tauri build（含 cargo + bundler）
#   [4/5] copy -> release\TeachWrite.exe     [4/6] copy -> release/TeachWrite.app + .dmg
#   [5/5] 桌面快捷方式 TeachWrite.lnk         [5/6] 桌面替身（Finder alias，可 --no-alias）
#                                             [6/6] 产物自检（arch / 最低系统 / 图标 / Gatekeeper）
#
# 为什么第 3 步是 `tauri build` 而不是裸 `cargo build --release`：
# Windows 的交付物是**单文件 exe**（无安装目录、无随行资源），裸 cargo 产物拷出来就能用；
# macOS 的交付物是 **.app 包**（Info.plist / 图标 / 代码签名结构都在包里），
# 只有 tauri 的 bundler 会生成它。裸 cargo 产物是
# src-tauri/target/release/teachwrite（一个裸 Mach-O 可执行文件），
# 拖进 /Applications 里不是可用的应用。
#
# 关于 PyInstaller 的 --add-data：本项目**没有** PyInstaller 步骤
# （前端资产由 vite 打进 dist/，再由 tauri.conf.json 的 frontendDist 内联进二进制），
# 所以这里用不到。但若将来真加了，务必记住 **macOS 用冒号、Windows 用分号**：
#     macOS  : pyinstaller --add-data "assets:assets" ...
#     Windows: pyinstaller --add-data "assets;assets" ...
# 写错分隔符 PyInstaller **不报错**，只会静默漏掉整个目录，运行期才炸。
#
# 用法：
#     bash tools/package.sh                # 完整构建 + 打包 + 收集 + 自检
#     bash tools/package.sh --skip-build   # 跳过构建，只重新收集已有产物
#     bash tools/package.sh --check        # 只跑类型闸 + 前端构建，不打包
#     bash tools/package.sh --no-alias     # 不在桌面建替身
#
# 项目根由**本脚本自身位置**推导（tools/ 的上一级），所以仓库放在哪都能跑 ——
# 不写死任何盘符或绝对路径（对照 package.ps1 的 $PSScriptRoot）。
#
set -euo pipefail

SKIP_BUILD=0
CHECK_ONLY=0
MAKE_ALIAS=1

for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=1 ;;
        --check)      CHECK_ONLY=1 ;;
        --no-alias)   MAKE_ALIAS=0 ;;
        -h|--help)
            # 只打印文件头那段连续注释（从第 2 行起，遇到第一条非注释行就停），
            # 不写死行号范围 —— 否则改注释长度就会把 `set -euo pipefail` 一起打出来。
            awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
            exit 0
            ;;
        *)
            echo "未知参数：$arg（可用：--skip-build / --check / --no-alias / --help）" >&2
            exit 2
            ;;
    esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUNDLE_DIR="$ROOT/src-tauri/target/release/bundle"
APP_SRC="$BUNDLE_DIR/macos/TeachWrite.app"
DMG_DIR="$BUNDLE_DIR/dmg"
REL="$ROOT/release"
APP_DST="$REL/TeachWrite.app"
DESKTOP="${HOME:-$ROOT}/Desktop"
ALIAS="$DESKTOP/TeachWrite"

TSC="$ROOT/node_modules/.bin/tsc"
VITE="$ROOT/node_modules/.bin/vite"
TAURI="$ROOT/node_modules/.bin/tauri"

if [ ! -x "$TSC" ] || [ ! -x "$VITE" ] || [ ! -x "$TAURI" ]; then
    echo "缺少 node_modules 里的构建工具（tsc / vite / tauri）。先跑： npm install" >&2
    exit 1
fi

# ── [0/6] 停掉本仓库 bundle 里正在跑的实例 ────────────────────────────────
# 为什么必须做：.app 被打开时替换 Contents/MacOS/ 下的可执行文件会失败，
# 或者更糟 —— 留下一个「半个新包 + 半个旧包」的目录。
# 为什么按**完整路径**匹配而不是按进程名：按名字杀会把用户从别处
# （/Applications、另一个 checkout）打开的 TeachWrite 一起关掉。
if [ -d "$APP_DST" ]; then
    PIDS="$(pgrep -f "$APP_DST/Contents/MacOS/" 2>/dev/null || true)"
    if [ -n "$PIDS" ]; then
        COUNT="$(printf '%s\n' "$PIDS" | wc -l | tr -d ' ')"
        echo "[0/6] stopping $COUNT running instance(s) from $APP_DST"
        # shellcheck disable=SC2086
        kill $PIDS 2>/dev/null || true
        sleep 2
        # shellcheck disable=SC2086
        kill -9 $PIDS 2>/dev/null || true
    fi
fi

# ── [1/6] 类型闸 ─────────────────────────────────────────────────────────
# 与 package.ps1 的 B-2 同一条纪律：打包链路必须先过 tsc。
# （`tauri build` 的 beforeBuildCommand 也会跑 `npm run build`，
#   但那要等 cargo 起完；显式先跑一次能让类型错误在 3 秒内就报出来，
#   也是 --check 模式唯一要跑的东西。）
if [ "$SKIP_BUILD" -eq 0 ]; then
    echo "[1/6] tsc --noEmit (type gate)"
    "$TSC" --noEmit

    echo "[2/6] vite build"
    "$VITE" build
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
    echo "CHECK ONLY：类型闸与前端构建通过，未打包。"
    exit 0
fi

# ── [3/6] tauri build：cargo 编译 + .app/.dmg 打包 ────────────────────────
if [ "$SKIP_BUILD" -eq 0 ]; then
    echo "[3/6] tauri build (cargo + bundler)"
    # tauri.macos.conf.json 由 Tauri 2 **自动合并**（RFC 7396），不需要 --config：
    # 它把 bundle.targets 从 ["nsis"] 换成 ["app","dmg"]，
    # 并把窗口改成 decorations:true + titleBarStyle:Overlay（原生红黄绿三键）。
    # 注意 RFC 7396 里**数组是整体替换**，所以那份文件把 app.windows[0] 的
    # 每个字段都重写了一遍 —— 改窗口字段时两处都要改。
    # 默认补齐本地 ad-hoc 包签名；分发签名可通过 APPLE_SIGNING_IDENTITY 显式覆盖。
    APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}" "$TAURI" build -- --locked
fi

if [ ! -d "$APP_SRC" ]; then
    echo "找不到 .app 产物：$APP_SRC" >&2
    echo "（先跑一次不带 --skip-build 的 package.sh）" >&2
    exit 1
fi

# ── [4/6] 收集产物到 release/ ────────────────────────────────────────────
echo "[4/6] copy -> $REL"
mkdir -p "$REL"
rm -rf "$APP_DST"
# cp -R 保留 .app 内的符号链接与权限位；ditto 更贴近 Finder 的复制语义，优先用它
if command -v ditto >/dev/null 2>&1; then
    ditto "$APP_SRC" "$APP_DST"
else
    cp -R "$APP_SRC" "$APP_DST"
fi

DMG_DST=""
if [ -d "$DMG_DIR" ]; then
    for f in "$DMG_DIR"/*.dmg; do
        [ -e "$f" ] || continue
        cp -f "$f" "$REL/"
        DMG_DST="$REL/$(basename "$f")"
        break
    done
fi

# ── [5/6] 桌面替身（等价于 Windows 的 .lnk） ─────────────────────────────
# macOS 上**不能**用 Unix 符号链接代替：Finder/Launch Services 不把
# 指向 .app 的 symlink 当应用（双击打开的是目录，图标也是通用文件夹图标）。
# 真正的等价物是 Finder 替身（alias），只能由 Finder 自己创建。
if [ "$MAKE_ALIAS" -eq 1 ] && [ -d "$DESKTOP" ]; then
    echo "[5/6] alias -> $ALIAS"
    if osascript -e "tell application \"Finder\" to make alias file to POSIX file \"$APP_DST\" at POSIX file \"$DESKTOP\"" >/dev/null 2>&1; then
        echo "       created $ALIAS"
    else
        echo "       建替身失败（多半是自动化权限未授予）。手动做法："
        echo "       Finder 里选中 $APP_DST，按 ⌘L 复制，再 ⌘V 到桌面。"
    fi
else
    echo "[5/6] 跳过桌面替身（--no-alias）"
fi

# ── [6/6] 产物自检 + Gatekeeper 说明 ─────────────────────────────────────
echo "[6/6] 产物自检"
APP_BIN="$APP_DST/Contents/MacOS/teachwrite"
if [ -f "$APP_BIN" ]; then
    echo "APP  path  = $APP_DST"
    if command -v lipo >/dev/null 2>&1; then
        echo "APP  arch  = $(lipo -archs "$APP_BIN" 2>/dev/null || echo '(lipo 读取失败)')"
    fi
    PLIST="$APP_DST/Contents/Info.plist"
    if [ -f "$PLIST" ]; then
        echo "APP  min   = $(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$PLIST" 2>/dev/null || echo '(未声明)')"
        echo "APP  bundle= $(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PLIST" 2>/dev/null || echo '(未声明)')"
    fi
    if [ -f "$APP_DST/Contents/Resources/icon.icns" ]; then
        echo "APP  icon  = icon.icns OK"
    else
        echo "APP  icon  = 缺 icon.icns（bundle.icon 里的 icons/icon.icns 没被打进去）"
    fi
else
    echo "APP  path  = 缺 $APP_BIN（.app 结构不完整）" >&2
fi
if [ -n "$DMG_DST" ]; then
    echo "DMG  path  = $DMG_DST"
else
    echo "DMG  path  = (未生成；确认 tauri.macos.conf.json 的 bundle.targets 含 \"dmg\")"
fi

cat <<'GATEKEEPER'

── Gatekeeper / quarantine ──────────────────────────────────────────────
默认构建含本地 ad-hoc 完整性签名，不含 Developer ID 签名与公证。产物分两种情况：

1) 本机刚构建出来的（release/ 下）：没有 quarantine 标记，双击即可打开。

2) 经浏览器/邮件/聊天工具传到这台 Mac 的（尤其 .dmg 里的）：会被打上
   com.apple.quarantine，首次打开报「无法打开，因为 Apple 无法检查它是否
   包含恶意软件」。两种解法，任选其一：

   a. Finder 里 **右键 →「打开」→ 再点「打开」**（只需一次，之后正常）

   b. 命令行去掉隔离标记（对 .app 目录递归去）：
        xattr -dr com.apple.quarantine "release/TeachWrite.app"
      从 .dmg 装到 /Applications 的，就对
        /Applications/TeachWrite.app
      执行同一条命令。

   只挂载 .dmg 而未安装时，也可以先给 dmg 本身去标记：
        xattr -d com.apple.quarantine "release/TeachWrite_*.dmg"

   想分发给别人（不受此拦截）需要 Apple Developer 账号做
   codesign + notarytool + stapler，并配置
   tauri.conf.json 的 bundle.macOS.signingIdentity —— **本次范围之外**。
GATEKEEPER

echo "DONE"
