# TeachWrite Current Status

- 版本：0.1.0；独立源码，分支feature/teachwrite，无远端操作。
- 当前阶段：0.1.0功能实现与本机验收完成；完整源码和macOS arm64应用按交付说明封装。
- 已完成：独立身份与数据目录、资料白名单和作者确认、正文直接/间接变更硬保护、整章导览与历史/进度、顶部固定当前场景、手动完成/返回、双通道审读/批次状态/精确引用定位、资料回流与作者归档门。
- 已修复：跨书跨章异步污染、所有对应脏标签门、最后确认后停止、真实目录/文件链接绕过、AI搜索未来导览、预览平台夹具不一致、旧候选采用由AI保存正文、macOS本地包资源签名不完整。
- 证据：全量56文件897通过/4个上游条件跳过，Rust25通过，生产构建通过，浏览器模拟18项通过，macOS arm64包及真实进程烟测通过。
- 产物：release/TeachWrite-0.1.0-source.zip、release/TeachWrite-0.1.0-macOS-arm64.zip；完整性和校验和见release/SHA256SUMS。
- 说明：Windows/Linux仅提供源码、配置及CI矩阵，本次未原生实机验收；没有调用真实模型API，也没有Apple Developer ID公证。
- 交接：docs/HANDOFF.md；完整证据和保证边界：docs/VERIFICATION-LOG.md。
