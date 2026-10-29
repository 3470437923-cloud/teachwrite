# DeepCompose 开发与验收手册

本文件是构建、验证、排障的操作手册。改动代码前请先读 `README.md` 的「改代码前必读」与根目录 `AGENTS.md`。

---

## 1. 闸门（每次声称完成前必跑）

```powershell
cd S:\DeepCompose
.\node_modules\.bin\tsc.cmd --noEmit        # 期望 exit 0
.\node_modules\.bin\vitest.cmd run          # 期望全部通过
```

Rust 侧单测：

```powershell
cd S:\DeepCompose\src-tauri
cargo test --lib                            # 期望全绿
```

> ⚠️ **不要用 `cargo test --release --lib`**：release profile 带 `lto=true + codegen-units=1`，
> 在测试目标下会把 rustc 压爆（`STATUS_STACK_BUFFER_OVERRUN (0xc0000409)`，报
> `could not compile tokio`）。正式产物仍用 `cargo build --release`，那条路径是正常的。

> ⚠️ **项目目录改过名（writerD → KeepCompose → DeepCompose）时必须先删 `src-tauri\target`**：
> cargo 指纹里存着旧绝对路径，会报 `failed to read plugin permissions … os error 3`（错误信息里指向旧目录）。
> 删 target 冷编译即可恢复（release 冷编译实测约 3 分 37 秒）。改名本身若报
> `Access to the path … is denied`，先清掉上一次截屏留下的旧 exe 进程与残留运行器。

## 2. 打包

```powershell
npm.cmd run package
```

`tools/package.ps1` 的动作顺序：杀掉**本仓库构建产物**里正在运行的 `deepcompose` 进程（cargo 产物与
`release\` 交付副本都算；否则 cargo 无法替换 exe，`failed to remove deepcompose.exe`，os error 5，
且第 4 步覆盖 `release\DeepCompose.exe` 会报 "being used by another process"）→
**`tsc --noEmit` 类型闸门（B-2）** → `vite build` → `cargo build --release` →
复制 exe 到 `release\DeepCompose.exe` → 删除旧 `writerD.lnk` 与 `KeepCompose.lnk` → 刷新桌面快捷方式 `DeepCompose.lnk`。
脚本根目录从自身位置推导（不硬编码盘符路径）。cargo 缓存热时约 2 分钟；**删掉 `target` 后的 release 冷编译实测 3 分 37 秒**（改动项目目录名之后必须走这条路）。

> 目录与产物名以 `S:\DeepCompose` / `DeepCompose.exe` 为准（第二代更名 writerD → KeepCompose → DeepCompose 已完成）。

## 3. 桌面端验收（真实 exe，会话锁定屏幕时也能做）

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\capture.ps1
```

`capture.ps1` 默认截 `src-tauri\target\release\deepcompose.exe`（cargo 直出产物，可用 `-Exe` 覆盖；
`probe_win_style.ps1` / `probe_window.ps1` 默认截打包产物 `release\DeepCompose.exe`）：按 pid 挑最大的可见窗口
（避开 WebView2 辅助窗口）、必要时 `ShowWindow(SW_RESTORE)`、发一次 `ESC` 固定回主界面再截图
（否则齿轮被误点就会截到设置屏），输出到 `shots\`。

- 启动即最小化（截到 `160×28 @ (-32000,-32000)`）是已知现象，脚本已处理。
- `PrintWindow` 对未聚焦的 WebView2 会返回白图：截屏前必须 `SetForegroundWindow` 并等 0.5–1 秒。
- 运行中的 `deepcompose` 会占用 exe，重新打包前先关掉。

## 4. 浏览器预览沙箱（两主题取证，免 Playwright）

`preview.html` + `src/preview/`（内存文件系统替身劫持 `__TAURI_INTERNALS__`）让界面脱离 Tauri
直接在浏览器里跑，`?theme=dark|light` 切主题(dsblue 随 2026-10-06 主题撤下,旧配置值在 parsePrefs 迁移为 dark)、`?promo=1` 换演示书、`?welcome=1` 让首启弹窗在沙箱出现(缺省视为已「不再显示」,不挡截图与几何断言)、`?fail=prefs` 注入启动故障。dev-only，不进构建产物。

```powershell
.\node_modules\.bin\vite.cmd --port 5183 --strictPort      # 后台常驻
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --headless=new --remote-debugging-port=9223 --remote-allow-origins=* `
  --user-data-dir="$env:TEMP\deepcompose-edge" --window-size=1600,1000 `
  --enable-unsafe-swiftshader about:blank                  # 后台常驻
python tools\preview_shot.py                               # 两主题 × 三尺寸截图 + 几何断言
python tools\preview_shot.py --view settings
python tools\preview_diag.py --click ".wbtn"               # 抓页面异常原文
```

预览走 CDP + `websocket-client`，不依赖 Playwright。替身对未实现的命令会
`console.warn("[preview] 未实现命令…")` 留痕——跑 `preview_diag.py` 就能看出还缺什么。

## 5. 端到端对话验证

```powershell
python tools\mock_provider.py 8899                          # 另开一个窗口常驻
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\e2e_chat.ps1
```

`e2e_chat.ps1` 会把配置**覆写为本地 mock**，跑完记得恢复真实配置；
`e2e_live.ps1` 不覆写配置，用现有配置直连真实端点。

已知工具缺陷（非产品缺陷）：`SendKeys` 会吞字；**中文输入法会把整串按键截成未提交组合串**
——`e2e_chat.ps1` 已改为 `clip.exe` 粘贴 + 点击发送按钮；截屏前缺 `SetForegroundWindow` 会拿到白图。

## 6. 本机环境坑（都是实际踩过的）

| 坑 | 现象 | 规避 |
|---|---|---|
| 没有 `pwsh` | `pwsh : 无法识别` | 只有 Windows PowerShell 5.1；`.ps1` 走 `-NoProfile -ExecutionPolicy Bypass -File` |
| 执行策略拦脚本 | `npm` / `npm.ps1` 被拦 | 用 `npm.cmd` |
| PowerShell 写文件带 BOM | `JSON.parse` 失败 → 整份配置被静默忽略 | 产品侧 `parsePrefs` 已剥 BOM；脚本用 `[System.IO.File]::WriteAllText(..., UTF8Encoding($false))` |
| **PowerShell 写中文源码会毁文件** | GBK 双字节吃掉紧随的 ASCII 字符，脚本直接语法错误 | **绝不用 PowerShell 改源码**，一律用文件工具；`.ps1` 保持 ASCII |
| **vite dev server 开着时改项目内文件 → vite 致命退出** | `EBUSY: resource busy or locked` | **改文件前先停 dev server** |
| PS 传参给原生程序吞双引号 | `python x.py --eval '{"a":"b"}'` 报 `unrecognized arguments` | 传给 python/node 的表达式改用单引号 |
| 读运行时配置乱码且回显密钥 | PS 无 `-Encoding` 读 UTF-8 → 乱码 + 把整份配置（含 key）回显到 stderr | 一律 `python -c`（`json.load(open(p, encoding='utf-8'))`）或 `Get-Content -Encoding utf8` |
| React 19 + 新 JSX transform | `JSX.Element` 报 `Cannot find namespace 'JSX'` | 用 `ReactElement`（`import type { ReactElement } from "react"`） |
| Windows 窗口几何 | `set_size` 是**客户区**口径；窗口创建后第一次 `set_size` 会多一个标题栏高度 | 位置存外框、尺寸存 `inner_size()`；读回不一致就用同一个值重试（最多 3 次）；**反向按差额补偿是错的** |
| **系统提交内存耗尽** | vitest/vite/cargo 起不来：`VirtualAlloc failed` / `Out of memory`，而物理内存还有空闲 | 看 `Win32_OperatingSystem.FreeVirtualMemory`（提交余量，<500MB 必炸）；关掉吃提交的大户再跑闸门 |
| **项目目录改名后 cargo 崩** | `failed to read plugin permissions: failed to read file '\\?\S:\<旧目录名>\src-tauri\target\...' (os error 3)` | 指纹里存着旧绝对路径；**删掉 `src-tauri\target` 冷编译**（release 实测 3 分 37 秒） |

## 7. 数据与配置位置

| 内容 | 路径 |
|---|---|
| 作品根（默认） | `%USERPROFILE%\AI写小说\`（设置「数据」页可改，prefs `custom_novels_dir`） |
| 会话 / 快照 / 备忘录 / 技能 | `%USERPROFILE%\Documents\{writerd_sessions, writerd_snapshots, writerd_memos.json, skills}` |
| 配置 | `%APPDATA%\com.writerd\writerD\shared_preferences.json` |
| 窗口几何 | `%APPDATA%\com.writerd\writerD\window_state.json` |
| 运行时统计（新增） | `%APPDATA%\com.writerd\writerD\usage_stats.json`（token 按日分桶与余额快照，可随时删除） |
| 网页版参考栏登录态（D-057） | `%APPDATA%\com.writerd\writerD\webview-sessions\{deepseek,zhuque}`（子 webview 的独立 WebView2 数据目录；删掉 = 网页版退出登录，其余无影响） |

以上名字是**磁盘契约**（见 README 契约表），产品更名不改它们。

## 8. 批次工作方式

1. 动代码前先想清楚：**这批的验收命令是什么**。
2. 改完跑闸门（`tsc` + `vitest`，必要时 Rust 单测），必须全绿。
3. 原子提交，提交信息写清**做了什么 + 验证结果**。
4. 每批只做一件事；跨多文件的重构拆成可独立验收的小批。
5. 修掉某条已知边界时，同步更新 `docs/KNOWN-LIMITS.md` 的「处置」列并留下回归锁（销项规则见该文件 §6）；
   改动涉及用户拍板的裁决时，先在 `docs/DECISIONS.md` 追加条目再动代码。

## 9. 工具清单（tools/ 全量入口）

前面 §2–§5 只讲了主链路工具；这里是**全量索引**，新加脚本必须补进本节（E-4：曾有 10 个脚本
没有任何文档入口，下一个接手的人只能读源码猜用法）。

### 9.1 交付与验收链路（§2–§5 已详述，这里只列入口）

| 脚本 | 作用 |
|---|---|
| `package.ps1` | 打包：tsc 类型闸门 → vite build → cargo build --release → 复制 exe → 刷新快捷方式 |
| `capture.ps1` | 真机截屏取证到 `shots/`（`SetForegroundWindow` 后等 0.5–1s，否则 WebView2 白图） |
| `preview_shot.py` / `preview_diag.py` | 预览沙箱两主题截图 + 几何断言 / 页面异常原文 |
| `table_probe.py` / `table_shot.py` | 资料表格视图的**列宽 / 空列 / 状态符号 / 切换钮门控**取证（D-061~D-065）；见 §9.5 |
| `mock_provider.py` + `e2e_chat.ps1` / `e2e_live.ps1` | 本地 mock 提供商端到端 / 真实配置直连端到端 |
| `ds_probe.py` | 真实 Key 的 DeepSeek 接口探针（用法见 `AGENTS.md` §3；只读本机 Key，绝不打印） |

### 9.2 审计类脚本（退出码统一口径，可当判据）

**统一口径（E-3）**：`0` = 通过｜`1` = 有问题（脚本会逐条列出）｜`2` = 判不了（前提缺失/参数坏/
基线丢失）。**不允许"有问题也 exit 0"**，也不允许把"判不了"当通过。

| 脚本 | 作用 | 用法 | 退出码 |
|---|---|---|---|
| `_a11y_check.py` | 无障碍降级断言（prefers-* 分支真被命中）+ 整屏扁平度审计（零玻璃/零渐变/零滤镜）+ 过渡存活 | `python tools/_a11y_check.py` | 0 / 1 / 2（媒体态无法建立、探针一个都没落到元素上） |
| `_contrast_audit.py` | 按 WCAG 2.1 实测真实元素文字与其实际底色的对比度（报告写 `shots/`） | `python tools/_contrast_audit.py` | 0 / 1 / 2（一条都没量到） |
| `_style_audit.py` | 运行时「裸奔元素」审计：`el.matches()` 遍历全部规则，一个都不命中的元素即无样式落点 | `python tools/_style_audit.py`（默认含 about；要收窄用 `--flows none,chat,memo,theme,params,about`） | 0 / 1 / 2（未知 flow 名、一条都没量到） |
| `_css_coverage.py` | 类名覆盖：`git HEAD` 旧 CSS × `src/**/*.tsx` className × 当前 CSS 三方对比 | `python tools/_css_coverage.py`（需 git 可用） | 0 / 1 / 2（基线丢失：旧 CSS 已不在 HEAD，属重构窗口期一次性工具） |

这四个共同前提：**vite dev server（5183）+ 无头 Edge CDP（9223）已启动**（启动命令见 §4），
`preview.html` + `src/preview/mockBackend.ts` 提供预置数据；`_a11y_check` / `_contrast_audit` /
`_style_audit` 都复用 `_shot_flow.py` 的 `CDP` / `FLOWS` / `run_flow`（改它签名会同时波及三者）。

### 9.3 取证与交互类脚本

| 脚本 | 作用 | 用法与前提 |
|---|---|---|
| `_shot_flow.py` | 按交互流程截图（气泡/思考块/工具行/备忘录/输入聚焦）；同时是上面三个审计脚本的公共库 | `python tools/_shot_flow.py --out shots/_tmp --label chat --themes dark --flows chat`；FLOWS 的选择器钉死 mockBackend 预置文案，改预置数据会让流程 miss。**设置屏导航序号与 `SettingsScreen` 的 `navItems` 必须一一对应**(A-1 教训:B19 加「使用教程」后 about 从第 6 项变第 7 项,写死 `nth-of-type(6)` 会让 about 取证静默落在帮助页上) |
| `_compare_sheet.py` | 把 before/after 两套截图拼成并排对比图（`shots/compare/*.png`） | **必须指定输出目录**：`preview_shot.py --label before --out shots\preview-before` 与 `--label after --out shots\preview-after`（默认 `--out shots\preview` 与对比脚本要读的两个目录不同名，照抄会 0 张图且不报错）；`pip install pillow`；**输入缺文件是"跳过"不是"报错"，产出变少不等于验收全过** |
| `cdp_probe.py` | 物理屏幕关闭/会话锁定时仍可做 UI 交互验证（`eval` / `click` / `shot` / `alive`） | 应用须带 `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"` 启动（发布版刻意不开调试口）；`pip install websocket-client` |
| `uiwalk.ps1` | 脚本化 UI 走查：`click\|x,y` / `keys\|text` / `cap\|out.png` / `wait\|ms` 步骤串 | `.\tools\uiwalk.ps1 -Steps "wait\|2000;click\|640,400;cap\|shots\w1.png"`；坐标相对窗口左上角，跑动中移动/缩放窗口会让坐标失效；跑挂也只会清掉自己启动的进程 |
| `probe_window.ps1` | 真机窗口几何记忆（T0–T5 六个用例：默认居中 / 缩放后记住 / 最大化恢复 / 离屏回收） | 默认钉打包产物 `release\DeepCompose.exe`；会改写 `%APPDATA%\com.writerd\writerD\window_state.json`（**冻结契约路径，别改名**） |
| `probe_win_style.ps1` | 实测无边框窗口能否拖边缩放（`WS_THICKFRAME`）与最大化是否真的改变尺寸 | 需要真实交互桌面会话；锁定/无头会话的测量无意义 |

### 9.4 B19 崩溃取证与署名验收(2026-10-08 登记)

| 脚本 | 作用 | 用法与前提 |
|---|---|---|
| `_qp_probe.py` | 快捷提示词崩溃复现:按用户真实路径走一遍(点提示词条 → 发送 → 流式 → 工具行 → question 弹窗),**逐条打印页面异常原文** | vite 5183 + 无头 Edge CDP 9223;退出 0 无异常 / 1 有异常 / 2 跑不起来 |
| `_qp_perf_probe.py` | 单次发送期间的渲染成本读数(长任务、帧间隔、DOM 节点数、堆) | 同上;**纯测量,退出码恒 0 —— 它的 0 不是「通过」,只是「跑完了」**(判据看输出数字) |
| `_qp_stress_probe.py` | KL-PF-01 的复现与 A/B:按 N 轮脚本化发送把历史堆厚,再在下一次发送中测每 token 渲染成本;合批修复前后跑同一条序列即得对照 | 同上;退出码恒 0(测量)。修复前基线:35 消息 / 25 工具行 = 51ms 长任务、13 帧 >33ms;修复后长任务归零、worstGap 33.3ms |
| `b19_probe.py` | B19 端到端验收 7 组断言(A 首启弹窗形态 / B 勾「不再显示」落 `welcome_dismissed` / C 不勾下次仍弹 / D 标题栏「帮助」/ E 设置屏「使用教程」分页 / F 关于页作者卡与构建烙印 / G `open_url` 接线) | 同上;退出 0 / 1 / 2 与其它审计脚本同一口径。截图落 `shots/b19-*.png`;`?welcome=1` 控制弹窗在沙箱里出现(缺省视为已关闭,不挡两主题截图) |

> **B19 的验收顺序**(§8 口径:先闸门、再探针、最后发布件):
> `tsc` + `vitest` + `cargo test --lib` → `_qp_stress_probe.py`(确认长任务归零)→
> `b19_probe.py`(功能面)→ `_contrast_audit.py` + `_a11y_check.py` + `_style_audit.py`
> (新增的 `help` / `welcome` 两组 flow 必须一起跑,否则署名相关样式不在审计范围内)→
> `npm.cmd run package` → `capture.ps1` 真机截屏。
> 关于页作者卡与帮助页脚的署名**只在真机产物里**取自 Rust `app_info`;预览沙箱走
> `mockBackend.ts` 的同形替身 —— 沙箱全绿不等于发布件署名正确,打包后按 §10 第 3 条核 exe。

### 9.5 资料表格视图取证（2026-10-11 登记，D-061~D-065）

| 脚本 | 作用 | 用法与前提 |
|---|---|---|
| `table_probe.py` | 在**渲染后的 DOM** 上验表格视图那批裁决：① 声明的表真有 `<colgroup>` + `table-layout:fixed`，且**实测像素百分比**跟声明的 100 分制一致；② 未声明的表（细纲/粗纲/00/01/02/06禁用列表）**没有** colgroup、保持 `auto`；③ grid 表里没有空列（旧 `.dt-rowact` 删钮列），且 `.dt-rowdel` 还在；④ 状态渲染成 √/`?`/×，中文原值留在 `title`；⑤ 纯散文文档（人物库/03-全书大纲）**没有**切换钮 | `python tools/table_probe.py [--theme light]`；vite 5183 + 无头 Edge CDP 9223。退出 0 / 1（逐条列出不符）。**注意**：只有 grid 行表才该有 colgroup 与行末删钮，kv 字段卡两样都没有——探针按 `cls` 区分。沙箱夹具里的 `人物库.md` 是**按模板写的**（带六方面字段行）→ 有 kv → 有钮；**用户真书上那份是纯自然段 → 没有钮**，这一条由单测 `hasRealTable` 覆盖，探针测不到 |
| `table_shot.py` | 表格视图两主题截图（规则台账 / 追踪-伏笔 / 03-全书大纲 / 人物库），落 `shots/preview/table-<name>-<theme>.png` | `python tools/table_shot.py --theme dark --out shots\preview`；同上前提。**本模型无法看图**，截图是给人和后续图像模型复核用的；列宽这类几何判据以 `table_probe.py` 的实测数字为准 |
| `migrate_style_sr.py` | 把 06-写作风格.md 的「风格规则」从自然段迁成 `### SR-编号` 块 + 三行字段（B22 批 3） | `python tools/migrate_style_sr.py --file <06 路径> --check`（只看不写）→ `--write`（先落 `.bak-b22`）。**核心不变量**：规则文字从原文件里**切**出来（按 `。` 断句后按规格分组），拼回来必须与原文**逐字节相同**才允许写盘 —— 逐字保留由构造保证，不靠人手重打。段数/句数对不上就整体拒绝（`exit 1`），不会写出半迁移的文件 |

> 这两支脚本的列宽期望值**抄自 `src/core/store/doctable.ts` 的 `COLUMN_WEIGHTS`**——
> 改权重必须同步改 `table_probe.py` 的 `CASES`，否则探针会拿旧期望判新代码。
> `CASES` 的期望**可以按表给**（06 就有两张不同性质的 grid：规则表固定四列、禁用列表自适应），
> 一张文档一个期望说不清。`columnWeightsFor` 要求**列集完全一致**（个数与列名都对得上），
> 只对上一部分就整体放弃：部分匹配会产出比表格短的 colgroup，把整张表挤坏
> （首版实现漏了这条，被回归锁当场抓住）。

## 10. 署名与许可的验收(开源发布前必做)

1. **许可证三件套齐备**:根目录 `LICENSE`(GPL-3.0 全文)、`LICENSE.third-party.txt`
   (三方清单,与 `src/assets/fonts/*/LICENSE-*.txt` 互指)、`src-tauri/Cargo.toml` 的
   `license = "GPL-3.0-only"` 与 `tauri.conf.json` 的 `bundle.license` 三处一致。
2. **署名唯一真源在 Rust**:`src-tauri/src/lib.rs` 的 `AUTHOR / AUTHOR_SINCE / QQ_GROUP /
   DOUYIN_URL` 是编译期常量,经 `app_info` 命令下发;前端(`src/core/author.ts`)**只读不写**、
   不留第二份字面量。同一组常量由 `tauri-build` 写进 PE 版本资源(`LegalCopyright` /
   `CompanyName`),`build.rs` 另把提交号与构建时间烙进 `app_info.build`。
3. **核发布件**:打包后在 `release\DeepCompose.exe` 里搜得到 `Liumorrow` 与
   `Copyright © 2026 Liumorrow`(PE 资源段是 UTF-16LE,按宽字节搜)。搜不到 = 这批
   没带上 B19 的 Rust 改动,别发。
4. **仓库里不得有密钥**:发布前 `git grep -I -E "sk-[A-Za-z0-9]{16,}"` 必须无命中
   (API Key 只存在于 `%APPDATA%\com.writerd\writerD\shared_preferences.json`,硬纪律 2)。
5. **防「去署名再卖」靠结构性锚定**:单文件 exe 的资产可解包,字符串加密是减速带不是防线;
   真正的约束是 GPL-3.0 的传染性 + 编译期锚定 + 构建烙印可追溯(裁决 D-053)。

> **进程纪律（N-16）**：以上会启动 exe 的脚本，**只允许停"与自己 -Exe 同路径"的实例**，
> 一律不得按进程名强杀 —— 用户可能同时开着别的 checkout / 安装副本，按名字强杀等于删用户的后台程序。
