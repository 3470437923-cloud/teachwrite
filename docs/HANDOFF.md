# TeachWrite 0.1.0 交付说明

当前源码目录：本地 TeachWrite 目录。原 DeepCompose 项目未修改。

## 可运行产物与完整源码

- release/TeachWrite-0.1.0-macOS-arm64.zip：本机验证的Apple Silicon .app。解压后打开TeachWrite.app；可自行放入Applications。
- release/TeachWrite-0.1.0-source.zip：完整源码、测试、资源、锁文件、三平台打包及维护记录，解压得到TeachWrite目录。
- release/SHA256SUMS：两个归档的SHA-256；压缩包均检查ZIP完整性。

源码包排除.git、node_modules、dist、Rust target、release、测试截图/缓存、临时日志和环境配置。首次解压后运行npm ci；Rust按锁文件构建。

## 开始使用

打开应用后，在设置中配置自己的模型服务。TeachWrite不会读取旧DeepCompose密钥、会话或技能目录。选择原有作品或新建书，完善小说资料与细纲；第一章可直接生成导览，其后需上一章完成资料回流并由作者确认归档。

右侧专用教学入口负责导览、审读、资料回流与归档。默认快捷词只做目标讨论，不生成正文。正文顶部仅显示当前场景任务；作者手写后自行勾选。重新打开恢复旧进度；显式重生才新建版本。

审读保留问题列表、原文引用、定位与作者处理状态；作者自己改正文。旧引文因正文变化失效时禁止定位。导览与审读不写进正文。

旧候选稿仍可打开和编辑。作者点击采用并明确确认后，应用逐字复制当前稿为正式正文，保存覆盖前快照，保留旧候选；这项作者操作不经AI，且不自动归档。

## 本机已验收

- 56个测试文件：897通过，4个上游REAL_BOOKS条件跳过，无失败。
- Rust25通过，生产构建与类型检查通过。
- Chromium模拟后端18项交互检查通过；测试报告位于工作区.evidence/teachwrite。
- macOS arm64 release app打包成功，真实进程启动烟测通过，完整ad-hoc包签名验证通过。
- 本地ad-hoc签名不是Developer ID公证。脚本默认用它确保包资源完整，正式分发可通过APPLE_SIGNING_IDENTITY设置身份并单独配置公证。

## 其他平台构建

共同依赖Node22+、npm、Rust stable；先npm ci。Windows还需MSVC/WebView2，Linux需WebKitGTK4.1等构建库，完整清单见.github/workflows/desktop.yml。

- macOS：npm run package:mac -- --no-alias。
- Windows：npm run package:windows。
- Linux：npm run package:linux。
- 通用入口：npm run package；也可在目标平台npm run tauri:build -- --ci -- --locked生成安装包。

Windows/Linux已有原生配置和CI矩阵，但本次没有其实际编译、安装、运行证据；远端CI未执行。真实模型API也未调用。浏览器模拟检查不能替代这些验证。

## 后续维护

先读AGENTS.md、docs/STATUS.md、docs/VERIFICATION-LOG.md。保留正文硬权限、资料确认、作者进度和归档门。原仓库历史与未提交状态一并保留在工作目录，源码包不携带.git；本次未提交或推送外部仓库。
