# TeachWrite 维护手册

TeachWrite 是 DeepCompose 的独立衍生项目。正文完全由作者手写；AI 只生成场景级导览、审读意见和小说资料回流。开发已获用户授权，无需重复请求开工确认。

## 首先阅读
- docs/STATUS.md：当前状态与下一步。
- docs/TEACHWRITE-DESIGN.md：已确认产品边界。
- docs/CAPABILITY-MAP.md：模块与依赖。
- docs/DEVELOPMENT-LOG.md：开发检查点。
- docs/VERIFICATION-LOG.md：实际验证证据。
- docs/DECISIONS.md：保留上游决策并追加 TW 决策。
- docs/IDENTITY-IMPLEMENTATION.md：独立应用身份、数据路径、三平台构建。

## 正文不可由 AI 修改
src/core/ai/writerPolicy.ts 是 AI 文件变更白名单；exec.ts 的写入、删除、复制、重命名均调用它。真实 controller 会话打开 confirmWrites，任何资料改动都须作者确认。导览、审读请求用 sendIsolated，零文件工具。不要添加跳过这些限制的模式或开关。

作者点击正文编辑器保存是独立路径，保留写前快照和 oplog。禁止将 AI 输出传入正文编辑值、粘贴函数或正文保存出口。AI 不判断步骤完成，不勾选、不推进。

导览/审读使用严格 JSON schema；schema 校验不等于语义上能证明字符串一定不是小说正文。不要用关键词启发式的通过结果声称绝对保证所有模型输出正确。正文文件的访问权限由执行层保证。

## 目录与兼容
作品内保留 小说资料/章节内容/待确认/已处理/审核/个人改稿/.openwrite_manifest.json/.openwrite_recycle/.openwrite_backup/writerd_oplog 等旧契约，不迁移旧书。
应用数据独立到系统 appData/com.teachwrite.desktop；不要读写旧 DeepCompose prefs、会话或技能目录。默认作品根保持兼容，用户可选择同一作品。
新增导览：小说资料/写作导览/第N章-导览.md；历史 .history。审读：小说资料/审核/审读/<id>.json。作者归档确认：writerd_oplog/teachwrite/第N章-归档.json。
AI 普通工具不能修改导览进度、审读状态或归档凭据。这些属于作者动作。

## 代码地图
- src/core/teaching/guide.ts：严格解析、版本历史、手勾进度。
- src/core/teaching/review.ts：审读批次、原文引用、SHA-256定位保护。
- src/core/teaching/workflow.ts：归档门、章节选择、教学提示词和资料读取。
- src/ui/useTeaching.tsx：教学入口、生成、审读、回流与作者确认。
- src/ui/teaching.css：顶部固定导览与审读面板。
- src/ui/MainWorkbench.tsx：原三栏界面与作者正文编辑。
- src/core/tools/exec.ts：资料白名单、确认、快照和工具执行。
- src/core/store/authorWrite.ts：作者保存/采用落盘后的标签基线与并发输入保护；切书/关窗守卫。
- src/core/ai/controller.ts：请求装配、会话、用量；独立任务零工具。
- src-tauri/src：原语、SSE、系统目录、窗口及网页子视图。

## 开发验证
本机 Node 用 /opt/homebrew/bin/node；内置签名 Node 无法 dlopen Rollup 原生模块，不是依赖缺失，不要反复安装来绕过。
- node node_modules/typescript/bin/tsc --noEmit
- node node_modules/vitest/vitest.mjs run
- npm run build
- cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
- npm run tauri:build -- --bundles app -- --locked（macOS）
首次 Rust generate_context 需要前端 dist 已构建。Windows/Linux 实机验证与本机模拟分开记录，不能声称 CI 未跑的平台已通过。

## 工作纪律
不改原 DeepCompose 项目；不将密钥写入源码/日志/测试；不读运行时配置回显 Key；不降低测试断言或跳过失败用例。每个检查点更新 STATUS、DEVELOPMENT-LOG、VERIFICATION-LOG，不用无依据百分比代替状态。旧文档中 DeepCompose 记录是上游历史，不代表 TeachWrite 当前行为。
