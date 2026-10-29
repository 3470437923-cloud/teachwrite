# TeachWrite Capability Map

| Module | Responsibility | Depends on |
|---|---|---|
| project-compatibility | 兼容 DeepCompose 作品目录与旧结构 | — |
| human-editor | 作者唯一正文编辑与保存 | project-compatibility |
| writer-policy | AI 正文文件变更硬限制；生成行为由作者约定与严格schema约束 | — |
| chapter-guide | 生成完整章节导览与逐场景步骤 | project-compatibility, writer-policy |
| guide-overlay | 顶部固定导览与作者推进 | human-editor, chapter-guide |
| review | 正文审读、引用、定位和逐项状态 | human-editor, writer-policy |
| archive-reflow | 资料回流、question 确认、归档 | project-compatibility, writer-policy |
| desktop-shell | Tauri 三平台窗口、文件、SSE、打包 | — |

Build order: project-compatibility → human-editor → writer-policy → chapter-guide → guide-overlay → review → archive-reflow → desktop-shell verification
