# TeachWrite

TeachWrite 是基于 DeepCompose 源码构建的独立小说写作桌面应用，版本 0.1.0。正文由作者亲手写，AI 提供按场景推进的写作导览、审读意见和小说资料回流。沿用 Tauri 2、React 19、TypeScript、Rust，不增加界面运行时框架。

TeachWrite 是独立第三方软件，与 DeepSeek 无隶属、赞助或背书关系。上游版权和作者归属保留在源码与许可文件中。

## 作者工作流

1. 打开已有 DeepCompose 作品，或通过开书向导建立新书，完善定位、设定、大纲和细纲。
2. 在右侧教学快捷区生成本章导览。第一章无需前置归档；下一章必须先完成上一章资料回流与作者归档确认。
3. AI 一次生成整章场景顺序并保存；正文顶部只显示当前步骤。你在下方 Markdown 编辑器手写正文，自己勾选完成，再进入下一场景。
4. 可以返回上一步重新写；重新生成导览保留旧版本和旧进度。导览从不插入正文。
5. 点击“审读本章”，选择剧情事实或风格表达通道。AI 只列问题、依据、影响和修改方向；引用的是你的原文，可定位到编辑器。你判断采纳或忽略，并自行修改。每次审读保留独立批次。
6. 完成本章后“资料回流与归档”，核对每次资料修改和最后归档确认，再开始下一章。归档后正文再次变化会使旧归档失效。

AI 工具执行层禁止正文写入、替换、追加、删除、复制和重命名，也拒绝通过目录或链接间接修改正文。导览与审读使用零文件工具的独立请求和严格结构校验。字符串的语义仍依赖模型遵守作者手写约定；结构校验不能证明模型永远不会输出不合规语句。

## 存储与兼容

原作品目录和格式保留，包括 小说资料、章节内容、待确认、已处理、审核、个人改稿、.openwrite_manifest.json、快照、回收站、oplog。打开旧作品不要求迁移，不改原 DeepCompose 应用。

新增内容按需建立：
- 小说资料/写作导览/第N章-导览.md：整章导览及作者进度；.history 保存写前版本。
- 小说资料/审核/审读/<批次>.json：审读意见和作者处理状态。
- writerd_oplog/teachwrite/第N章-归档.json：与实际正文匹配的归档确认记录。

专用导览与审读目录不在普通文件树直接展开，避免提前展示未来场景或直接编辑作者状态。持久化文件仍为本地可读格式。

应用身份 com.teachwrite.desktop。配置、会话、Key、技能、缓存、快照、用量和窗口状态默认放入各系统 appData 下的独立身份目录；不自动读取或导入旧 DeepCompose 配置。默认作品根继续使用用户目录下 AI写小说，用户可自行选择作品位置。断网仍可本地编辑、保存、查看历史；在线 AI 任务需要有效 API 配置和网络。

## 开发与构建

依赖 Node.js 22+、npm、Rust stable 及 Tauri 对应系统构建工具。Windows 安装 WebView2/MSVC；macOS 安装 Xcode Command Line Tools；Linux 安装 WebKitGTK 4.1 等系统依赖（见 CI workflow）。

~~~sh
npm ci
npm run typecheck
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
npm run tauri:dev
~~~

完整桌面端运行用 tauri:dev。浏览器内存后端仅供界面测试：运行 npm run dev 后访问 /preview.html，演示结果不代表真实模型或真实文件系统已验收。

三平台自动选择打包：npm run package。也可分别使用 npm run package:windows、npm run package:mac、npm run package:linux。CI 同时定义 macOS、Windows、Linux 构建，实际已运行情况以 docs/VERIFICATION-LOG.md 为准。

~~~sh
# macOS app bundle with local ad-hoc integrity signature
APPLE_SIGNING_IDENTITY=- npm run tauri:build -- --bundles app -- --locked
# installer bundles on the native target platform
npm run tauri:build -- --ci -- --locked
~~~

不要用模拟平台测试替代对应系统上的安装、启动和文件访问验证。

## 维护记录

当前进度：docs/STATUS.md。设计：docs/TEACHWRITE-DESIGN.md。模块地图：docs/CAPABILITY-MAP.md。开发日志：docs/DEVELOPMENT-LOG.md。验证证据：docs/VERIFICATION-LOG.md。身份与三平台实现：docs/IDENTITY-IMPLEMENTATION.md。架构裁决：docs/DECISIONS.md。维护约束：AGENTS.md。

继承的其他文档保留上游历史，若与 TeachWrite 新设计冲突，以 TeachWrite 专用文档和当前测试契约为准。
