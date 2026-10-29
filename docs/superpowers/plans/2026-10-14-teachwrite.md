# TeachWrite Implementation Plan

**Goal:** Build a three-platform TeachWrite desktop app that reuses DeepCompose local writing infrastructure while enforcing author-only正文 creation.

**Architecture:** Start from an isolated DeepCompose source snapshot. Keep project/store/fs/Tauri foundations compatible, then introduce a policy boundary that removes AI正文 writes before adding guide, review, and reflow workflows.

**Tech Stack:** Tauri 2, React 19, TypeScript, Rust, Vite, Vitest.

**Spec:** docs/TEACHWRITE-DESIGN.md

## Global Constraints
- macOS, Windows, Linux are first-class targets.
- DeepCompose作品目录和旧结构必须完整兼容。
- 正文只来自作者手写；AI不得生成或写入正文。
- 导览一次生成完整章节步骤，UI按场景逐步解锁。
- 审读只给意见、引用和定位，不生成替代正文。
- 资料回流沿用快照、question、schema和oplog。
- TeachWrite使用独立应用数据和 com.teachwrite.desktop。

## Tasks
1. Independent identity and build baseline.
2. Writer policy and forbidden-body regression locks.
3. Guide data model and persistence.
4. Chapter guide generation with previous-archive gate.
5. Fixed guide overlay and manual progress.
6. Review workflow with source quote/location and issue states.
7. Archive reflow gate.
8. Three-platform build configuration and delivery records.

## Completion evidence — 2026-10-15
Tasks1–7 implemented and integrated. Full regression:56files /897passed /4upstream conditional skips; native Rust25passed; browser simulated18checks; macOS arm64app built and launched. Windows/Linux build configuration and native scripts delivered, actual native acceptance remains unverified on those systems. See docs/HANDOFF.md and docs/VERIFICATION-LOG.md.
