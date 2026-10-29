# TeachWrite Verification Log

## 2026-10-15 — 0.1.0 本机验收

| Scope | Command / Evidence | Result |
|---|---|---|
| 完整前端与集成回归 | `node node_modules/vitest/vitest.mjs run --reporter=dot` | 56 文件通过；897 passed / 4 条件 skipped / 0 failed |
| 真实 controller 资料确认 | controller.test.ts | 7/7；追加隔离用量统计临时目录后再次通过 |
| 生产资源和类型检查 | npm run build，含 tsc --noEmit | PASS；135 modules，生产产物已嵌入最终应用 |
| Rust 原生单测 | cargo test --manifest-path src-tauri/Cargo.toml --lib --locked | 25 passed / 0 failed |
| macOS Apple Silicon app | APPLE_SIGNING_IDENTITY=- npm run tauri:build -- --bundles app -- --locked | PASS；TeachWrite.app，约10.2 MiB |
| 真实原生进程启动 | 启动最终release可执行文件；确认进程持续运行后停止烟测进程 | PASS；不代表原生全部交互验收 |
| app资源签名 | codesign --verify --deep --strict（ad-hoc） | 本地手工签名验证已通过；最终自动签名构建同样成功 |
| Bash打包语法 | bash -n tools/package.sh tools/package-linux.sh | PASS |
| 源码差异格式 | git -c core.whitespace=cr-at-eol diff --check | PASS |
| 浏览器操作链 | tools/teachwrite-browser-check.cjs；.evidence/teachwrite/browser-report.json | 18项PASS；无pageerror |
| Windows / Linux | 三平台workflow与原生打包脚本 | 已提供；此环境未实机执行，也未推送/触发远端CI |
| 真实模型API | 未使用作者密钥或调用真实模型 | 未验收；不能用预览模拟替代 |

上表中的 node / npm 实际使用本机 Homebrew Node（/opt/homebrew/bin）；内置带签名 Node 对 Rollup 原生模块的加载失败已定位，未将其误当成缺包处理。

## 浏览器覆盖及边界

Chromium中实际操作18项：空白作者正文创建、单一当前场景、未来标题锁定、整章导览独立落盘、手勾推进、返回前步、固定面板与独立编辑滚动、审读不改正文、原文引用选择、采纳状态持久化、多批次保留、陈旧引文定位失效、归档前下一章锁定、作者确认后解锁、不自动生成下一章、归档后作者改稿使门失效、视口布局、无运行异常。

浏览器使用预览内存文件系统及模拟AI SSE，未访问作者真实作品或真实API。预览固定使用Windows虚拟磁盘，因此预览HTML在模块加载前模拟Windows平台；该入口不进入生产bundle。截图是测试产物，本轮未人工视觉核验图片。

## 有效安全回归

- writer-policy与实际agent/controller：正文直接或目录间接写入、追加、删除、覆盖复制、改名、嵌套链接、资料确认取消/空答/无通道均拒绝，且拒绝发生在快照与正文变更前。
- typed path：导览、历史、审读和归档的根/祖先/目标链接拒绝；真实链接攻击先RED后GREEN。路径36、guide49、review39、workflow13定向共137项通过，亦包含在完整回归中。
- 普通AI工具直接读取导览、搜索导览目录以及从项目根搜索均不能披露未来步骤；3项用真实临时文件先RED后GREEN。
- UI异步：跨章、跨作品、所有对应脏正文标签、停止、工具失败、最后确认后取消以及实际写归档前重查；hook6+workflow13通过，包含在完整回归中。
- 条件跳过来自上游REAL_BOOKS只读实书测试组：本机不存在其指定目录，4例均未执行；没有为绕过失败新增skip。

## 最后保存竞态复核

独立复核发现并修复三项：异步保存把新增输入清dirty、采用覆盖等待期间的目标新输入、采用落盘后索引刷新失败留下旧干净标签。authorWrite.ts以实际写入文本为基线；Main实际保存与采用出口接入。确认后和快照后检查最新标签，写盘后先同步再刷新；并发输入保留。又补切书/关窗期间新增脏标签守卫。9项回归先RED后GREEN，包含在最终56文件897通过中；三原finding经独立只读复核关闭。

## 不应扩大声称的保证

schema和提示词无法证明任意模型字符串在语义上绝不含示范正文；文件执行边界才是正文写入硬限制。当前FsBridge无no-follow原子打开，无法声称抵抗另一进程同时恶意换链。当前只有macOS arm64原生构建与进程烟测，尚无Windows/Linux安装启动或真实模型端到端证据。默认ad-hoc签名只做本地完整性封装，未做Developer ID公证。
