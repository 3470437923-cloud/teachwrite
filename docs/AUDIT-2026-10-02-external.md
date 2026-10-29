# DeepCompose 问题清单（外部审计，2026-10-02）

> **性质**：本文件是**外部 agent 通读仓库 + 实际导入一部作品**后的问题汇总，**只记录、不修复**。
> **与既有账本的关系**：`docs/KNOWN-LIMITS.md` 是项目自有的缺陷账本（含已修与保留项）；本文件是**一次独立复盘的增量发现**，其中 A-1/A-2、B-1/B-3/B-4、I-1/I-10 等条目**未被现有账本记录**。
> **证据等级**沿用项目口径：`[已实测]` ＝ 有当场跑出的输出；`[代码判定]` ＝ 读代码即可确定；`[推演]` ＝ 由代码逻辑推导。
> **修复状态**：**全部未修**。本文件不含任何补丁。
> **核对基线**：`tsc --noEmit` exit 0｜`vitest run` 29 文件 / 404 例全绿｜`cargo test --lib` 19 例全绿｜产物 `release/DeepCompose.exe` 10,507,776 B（2026-09-29 23:39，比最新源码新）。

---

## 0. 汇总表

| 分类 | 编号区间 | 条数 |
|---|---|---|
| 一、导入/作品协议层（本轮新发现） | I-1 ~ I-12 | 12 |
| 二、闸门与工具"假绿"（高危） | A-1 ~ A-8 | 8 |
| 三、架构半成品 | B-1 ~ B-5 | 5 |
| 四、设置屏实质缺陷 | C-1 ~ C-6 | 6 |
| 五、交互与状态归属 | D-1 ~ D-3 | 3 |
| 六、文档/注释陈旧 | E-1 ~ E-4 | 4 |
| 七、仓库状态 | F-1 ~ F-2 | 2 |
| **合计** | | **40** |

**优先级建议**

| 层级 | 条目 | 理由 |
|---|---|---|
| 必须最先处理 | F-1、A-1、A-2 | F-1 有丢失风险；A-1/A-2 使"闸门全绿"这个结论本身失效 |
| 契约级偏差 | B-1、B-3、B-4、A-3、I-10 | 与文档承诺或用户裁决不一致 |
| 工具债 | A-4 ~ A-8、E-2 ~ E-4 | 工具在"看起来在工作"，但审计不到真实对象 |
| 体验债 | C-1 ~ C-6、D-1 ~ D-3 | 影响日常使用与安全习惯 |
| 协议缺口 | I-1 ~ I-9、I-11、I-12 | 作品/文档协议没有校验与登记 |

---

## 一、导入/作品协议层（本轮新发现，12 条）

### I-1 `createProject` 会写清单，但扫描不会 —— 缺失清单的作品是"半可见" `[实测 + 代码判定]`

- **实测**：手工按磁盘契约建作品目录但不建 `.openwrite_manifest.json` 时，作品无受管身份；补建后 `json.load` 校验字段 `{version, updatedAt, items, orders, manualOrderParents}` 齐全，version=1。
- **代码判定**：`src/core/store/project.ts` 的 `loadProject` 对清单**容错**（缺失按空清单），作品能列、能开；但 `projectExists()` 以 `projectManifestFile(root)` 是否存在为**唯一判据** —— 缺清单的目录不算受管作品。
- **影响**：同一部作品存在两套判据（"能列出" vs "算受管"），且无用户可见提示；`scanBooksRoot` 也不会顺手补清单。

### I-2 内容层年代错误：1990—1991 年写"拿出手机打电话" `[已实测]`

- **实测**：源细纲第 23 章第 4 场原文"他拿出手机给肖楚打电话，肖楚说晚上碰面"。
- **性质**：源内容错误，非软件缺陷；但暴露流程缺口 —— 软件没有任何机制（词表、技能约束、lint）会在导入/起草时顶出年代错误。
- **已记录**：目标作品的 `追踪-废弃设定.md` D028，起草该章须改为对讲机/单位电话。

### I-3 模板把「待填写」当内容而非状态，填充完只剩字符串语义 `[代码判定]`

- **代码判定**：`templates.ts` 的 14 份模板中「待填写」出现 60+ 处；`onboarding.ts` 只认 `- {label}：待填写` 整行。
- **影响**：填充完成后，`00-项目状态.md` 的进度/下一步等字段**不可结构化查询** —— 应用无法据此判断写作进度，只能把整份文档丢给模型读。填充越满，越依赖模型阅读理解。

### I-4 细纲自述的伏笔数量无法被核对 `[已实测]`

- **实测**：细纲《附录》声明"已回收伏笔 29 条、预留伏笔 8 条"，但全篇**没有给出任何伏笔编号或清单**（2278 行通读确认）。
- **影响**：这类"作者自述统计"在软件里没有落点，导入者必须自建编号体系（本次重建为 F001—F168 并做母题归并收敛到 29+2）；换人导入会得到完全不同的编号。

### I-5 同一作品有"两种身份文件"，语义重叠 `[代码判定]`

- **代码判定**：`.openwrite_manifest.json`（显示名与排序）与 `recycle_manifest.json`（回收站清单）都在 `isSystemEntryName` 的排除范围内。
- **影响**：`.openwrite_*` + `writerd_*` + `recycle_manifest.json` 三条独立判定拼成一个函数，是**三次改名叠加**的产物；任何新增系统文件的作者都必须同时知道这三条。

### I-6 附加文档（`世界观.md` 等）在代码里没有登记，却在既有作品中存在 `[实测 + 代码判定]`

- **实测**：既有作品 `变成狗也要喜欢直男！/小说资料/` 含 `世界观.md`、`写作禁忌.md`、`风格规范.md`，而 `DOC_TEMPLATES` 只有 14 份、不含这三份。
- **代码判定**：`listDocs` 把 `小说资料\*.md` 平级全列（只读不判），附加文档能显示；但 `createProject` 不生成、`onboarding.ts` 不填、无任何地方记录"一部作品应该有多少份"。

### I-7 内容树深度上限 4 层会**静默截断** `[代码判定]`

- **代码判定**：`project.ts` 的 `buildContentTree(fs, root, maxDepth = 4)`，超出即 `return []`（注释说明是为防符号链接成环）。
- **影响**：`小说资料\个人改稿\第1卷\第1章\对比\…` 这类深目录在 5 层之后直接消失，左栏看不到、无提示，用户会以为文件丢了。

### I-8 `章节摘要.md` 模板自带第 1 章占位，与应用回写路径冲突 `[已实测]`

- **实测**：模板内容含 `## 第一卷` + `### 第1章 摘要` + `（待正文采用后由回写追加）`。
- **影响**：按模板生成后再逐章 append，第 1 章会出现**两条**同名摘要；本次导入用整份重写规避，但应用自己的回写路径会撞上这个占位。

### I-9 `追踪-*` 模板结构固定，但实际内容形态差异极大 `[代码判定]`

- **实测**：模板给的是单条目样板（如 `## 人物名（模板，新建人物时复制本条目）`），真实作品常用表格 + 逐章状态矩阵。
- **代码判定**：`markdown.ts` 的 `appendToSection` / `replaceInSection` 只按 **ATX 标题**定位节；表格与状态矩阵没有可定位的节标题时只能整段 append。
- **影响**：格式优先的回写能力（追加/节内替换）对"表格型内容"基本失效。

### I-10 "只展示已实现的功能"这条纪律在技能层被自己破了 `[代码判定]`

- **代码判定**：`assets/builtin-skills/skill-creator/SKILL.md` 教模型使用 `create_skill` 与 `update_skill` 两个**不存在的工具**，并宣称"内置技能修改时会自动克隆为用户副本"。
- **实测**：真实注册工具只有 6 个（`spec.ts` 的 `IMPLEMENTED_TOOLS`），`exec.ts` 的 dispatch 无这两个名字 → 调用落到 `err("Unsupported operation: …")`。
- **影响**：会直接诱发幻觉调用，违反 README 第 11 条纪律。

### I-11 `KNOWN-LIMITS.md` 自称"唯一的只报告未修清单"，但已修条目也留在里面 `[已实测]`

- **实测**：文件头写"本文件是**唯一的「只报告未修」清单**"，而同文件「处置」列为 `已修` 的条目有 20+ 条（KL-AI-01/02/06/08/11/16、KL-ST-02/04/07/09、KL-TL-02/04/07/10、KL-DF-09/10、KL-UI-02~18）。
- **影响**：定位（未修清单）与形态（全部条目 + 处置状态）矛盾，按文件头理解会漏读已修结论。

### I-12 没有"导入"动作，也没有任何导入校验 `[代码判定 + 实测]`

- **代码判定**：全仓搜索，`createProject` 之外没有"把外部内容导入作品"的入口；`tools/` 下也没有导入校验脚本。
- **实测**：本次导入由外部 agent 做了 38 项断言（34 章 / 68 节 / 14 件套 / CRLF / 编号连续性 / 中文完整性 / 清单可解析），**这些断言在软件里一条都不存在**。
- **影响**：任何人或 AI 往作品根放内容，软件既不校验也不提示；残缺作品会以"正常作品"的样子出现在列表里。

---

## 二、闸门与工具"假绿"（高危，8 条）

### A-1 审计工具的导航索引错位一格，导致"假绿" `[已实测]`

设置页导航只有 **6 项**（provider / skill / params / theme / data / about），实际选择器：

| 工具 | 位置 | 选择器 | 实际点到 | 后果 |
|---|---|---|---|---|
| `tools/_a11y_check.py` | `:172` | `.a-nav-item:nth-of-type(6)` 标"设置·数据" | **关于** | **Data 页从未做过扁平度审计** |
| `tools/_a11y_check.py` | `:173` | `.a-nav-item:nth-of-type(7)` 标"设置·关于" | 不匹配 | 原地不动＝provider 页重复 |
| `tools/_contrast_audit.py` | `:218` | `:nth-of-type(6)` 作为 Data | **关于** | `.a-btn-danger`（在 `SettingsScreen.tsx:1522`，属 DataSection）不在此页 → 三主题全部 `SKIP`，**危险色对比度从未被真实测量** |
| `tools/_shot_flow.py` | `:58` | `:nth-of-type(7)` 作 `about` 流程 | 不匹配 | 所有 about 截图静默停在 provider |

正确索引应为 **data＝5、about＝6**（params＝3、theme＝4 是对的）。

### A-2 `tests/` 从不做类型检查 `[已实测]`

```
tsconfig.json  include = ["src"]
```

- **实测**：往 `tests\_probe_typecheck.ts` 写入 `const x: number = "not a number";` → `tsc --noEmit` **exit 0**（根本未读该文件）。
- **影响**：`npm run typecheck` 与 `npm run build`（`tsc --noEmit && vite build`）都不覆盖 **30 个测试文件 / 404 个用例**；生产代码改签名后，测试可带类型错误"全绿"到运行时才炸。
- **修复注意**：`tests/support/nodeFs.ts` 用 `node:fs`，需连带 `types: ["node"]` 与 `@types/node`，不是一行改动。

### A-3 `ModelCombo` 不存在，文档三处自相矛盾 `[已实测]`

- `docs/KNOWN-LIMITS.md:128`（KL-UI-03，B10）：写"换成自绘组合框 `ModelCombo`（…**可手填**）"
- `docs/KNOWN-LIMITS.md:133`（KL-UI-08，B11）：写"改为只能点选的 `ModelSelect`"
- `README.md:35`：仍写"模型清单检测 + **手填**"
- **实测**：代码中只有 `ModelSelect`（2 处引用），`ModelCombo` 仅存在于文档。

### A-4 `_css_coverage.py` 的基线已经丢了 `[已实测]`

```
git show HEAD:src/styles/glass.css
fatal: path 'src/styles/glass.css' does not exist in 'HEAD'   (exit 128)
```
HEAD 的 `src/styles/` 只有 `app.css / fonts.css / surface.css / tokens.css`。`git_show()` 忽略返回码与 stderr → 静默贡献空基线；且该脚本 **always exit 0**，无法作为闸门。

### A-5 `duplicate_detect.py` 正则打错，一个评分维度永久死掉 `[已实测]`

```python
# token-optimizer/scripts/duplicate_detect.py:61
m = re.search(r'^description:/s*(.+)$', content, re.MULTILINE)   # /s 应为 \s
```
`desc` 恒为空 → 文档宣称的 0.3 权重"描述重叠"维度永不生效。

### A-6 `cdp_probe.py` 连不上真机 `[代码判定]`

- 在 `src-tauri` 中 grep `remote-debugging|WEBVIEW2|additional_browser_args|9223` → **零命中**：WebView2 未开启远程调试，该脚本只能接 headless Edge 预览。
- 其 docstring 里的选择器 `.b-icon-btn.gear` 早已不存在（真机是 `button.wbtn[title="设置"]`）。
- `preview_shot.py` 里 `.wbtn` 的假设在 MainWorkbench 成立（齿轮是首个 `.wbtn`），但在 SettingsScreen 首个 `.wbtn` 是最小化 —— 跨屏复用有坑。

### A-7 `preview_shot.py` 仍在探已删除的玻璃时代选择器 `[代码判定]`

`.glass`、`.grain`、`.ambient .orb`、`.fitter`、`.win-frame`、`--bg-base` —— 全部在实色体系重构中删除；探测结果静默为空、不报错。

### A-8 `assets/builtin-skills` 是死资产：没有任何发布链路 `[实测 + 代码判定]`

- 全仓只有 `README.md:74` 提到该目录；`tools/package.ps1` 只复制 exe；`src-tauri/tauri.conf.json` 无 `resources`；TS/Rust 零引用。
- `src/core/skills/scan.ts` 只读 `Documents\skills`；`BUILTIN_SKILL_NAMES = {"novel-writer","skill-creator"}` → **5 个随包技能里只有 2 个被当作"内置"**，另 3 个显示在「自定义」分组（与 `README.md:74` 的"内置技能（5 个）"不符）。
- 设置页技能页空态文案"内置技能位于 `Documents\skills\`，首次扫描后将出现在这里"**语义错误**（那里只会有用户自己放的）。
- `parseFrontmatter` 不剥 YAML 引号 → `token-optimizer` 的 description 带字面双引号注入系统提示词；其 `triggers/version/agent_created` 三个扩展字段被静默丢弃。

---

## 三、架构半成品（5 条）

### B-1 路径分级的"根外需确认"根本没接线 `[代码判定]`

`src/core/tools/pathGuard.ts` 的拒绝文案自己承认：

```
路径在项目/skill 目录外，需用户确认，但确认机制未启用:
```

`GuardRoots.allowedDirs` 与 `NEEDS_CONFIRMATION_PREFIX` 都已实现，但**没有任何调用方**能把 `allowedDirs` 填进去。所谓"三个授权根内直读、根外必须用户确认"，实际行为是"根外一律拒绝"。

### B-2 Vite `build` 跳过了类型检查闸门 `[代码判定]`

- `package.json`：`"build": "tsc --noEmit && vite build"`
- `tools/package.ps1:47`：`& (Join-Path $root "node_modules\.bin\vite.cmd") build` —— **直接调 vite，没有 tsc**
- 后果：打包路径不跑类型闸门，只有手动 `npm run build` 才跑。

### B-3 会话列表与删除用的路径比较口径不同 `[已实测]`

- `src/core/store/session.ts:252` `deleteSessionsForProject` → 归一化 `samePath()`（大小写不敏感、分隔符统一）
- `src/core/store/session.ts:275` `listSessions` → `e.projectPath === projectPath`（**严格相等**）

后果：路径大小写/分隔符风格不一致时，侧栏过滤不出会话，但删除又能匹配上 → 留下一批"点开报作品不存在"的孤儿会话。

### B-4 冷读的思考档位与 `D-014` 不符 `[代码判定]`

- `docs/DECISIONS.md` D-014 写"冷读跟随用户开关"。
- `src/core/ai/controller.ts:228` 的 `sendIsolated` 调 `providerOf(opts.prefs)`（不传会话级档位）→ 跟随的是**配置级默认**。
- 后果：用户在主界面把思考关掉，冷读仍可能开着思考。回流与压缩是显式 `thinking:false`，这两条是对的。

### B-5 `contextLimit` / `reservedOutputTokens` 只夹下界不夹上界 `[已实测]`

```tsx
// src/screens/SettingsScreen.tsx
update("contextLimit", Math.max(1, Math.round(v)) * 1000);                        // 无上界（:1161/:1165）
update("reservedOutputTokens", (v === null ? … : Math.max(1, Math.round(v))) * 1000); // 无上界（:1185/:1189）
update("maxOutputTokens", clamp(Math.round(v), 1, 384) * 1000);                    // 有上界（:1217/:1221）
```
KL-DF-09 当时只修了 `maxOutputTokens`。

---

## 四、设置屏实质缺陷（6 条）

### C-1 API Key 边输边发给上游 `[代码判定]`

`ProviderSection` 有一个 600ms 防抖的 `useEffect`，依赖 `[llmBaseUrl, apiKey, useAnthropicFormat]`，触发 `ai_models`。Key 是受控输入 → 每半截 Key 都会被发往用户填的任意端点；同时 900ms 防抖自动保存把半截 Key **落盘**。这是"密钥不入库/不回显"纪律在**行为层**的破口（不泄露到仓库，但会发出）。

### C-2 `SkillSection` 的开关绕过 dirty/save 管道 `[代码判定]`

父级传 `onActiveChange={(ids) => setForm(...)}`（`SettingsScreen.tsx:444`），既无 `setDirty(true)` 也无 `setSaveMsg("")`；`toggle()` 自己直接 `savePrefs`，而父级 form 在管道外被改。

### C-3 `SkillSection` 把 `Row` / `GroupHead` 定义在组件体内 `[代码判定]`

每次渲染都是新组件身份 → 在搜索框里每敲一个字，整组技能行 unmount/remount。

### C-4 `ThemeSection` 的 `flash` 是死代码 `[代码判定]`

解构了 `onFlash`（`:1263/:1273`）却从不调用；`:1310` 的 `<div className="a-flash">` 依赖它，永不显示。

### C-5 Ctrl+S 无条件 `preventDefault` `[代码判定]`

`useEffect` 无依赖数组（每次渲染重新订阅）；`e.preventDefault()` 在 `if (section === "provider" || "params" || "theme")` **之前**执行 → 在 Skill / 数据 / 关于 三页按 Ctrl+S 被静默吞掉且什么也不发生。

### C-6 `!boot` 兜底分支按其自身注释不可达，而预览替身仍在为它写文档 `[代码判定]`

- `SettingsScreen.tsx:112–137` 的"配置未加载，请重启应用。"屏，注释承认"该分支目前不可达：boot 失败时 MainWorkbench 会渲染自己的「启动失败」屏"。
- 但 `src/preview/mockBackend.ts:11-12` 仍写 `?fail=prefs` 用于"验证「配置未加载」兜底页" —— 实际抛出后是 MainWorkbench 的「启动失败」屏。

---

## 五、交互与状态归属（3 条）

### D-1 `useDialogFocus` 只拦 keydown，无 focusin 兜底 `[代码判定]`

多层模态叠开时（回收站之上再开手打确认），两层监听都在，Tab 会被两个处理器各自 `preventDefault + focus`；卸载内层会把焦点还给外层记录的 `activeElement`。鼠标点击也无 focusin 兜底（`.memo-modal.dock-wrap` 是有意例外）。

### D-2 `MainWorkbench` 的状态归属问题 `[代码判定]`

- 冷读对话框的 `coldPrior` / `coldGoal` **打开时不重置**（与 `NewBookWizard` 每次打开整体重置的做法不一致）。
- 「需要你的选择」的提交键**不校验是否已选**，可提交全空答案数组。
- `continueWriting()` 取 `pending[pending.length-1]`（**索引末位**）而非章号最大的候选。

### D-3 三处冗余/缺能力 `[代码判定]`

- `RecycleBin` 的 `dirs` prop 只用于空值守卫、从不被读取（冗余）。
- `TitlebarWhale` 的 `panelLeft` 在展开期间不随布局变化重算（`measureAnchor` 只在 enter/pin/focus 调用）。
- `NewBookWizard` 在 `creating` 期间无取消途径（`onCreate` 挂住即锁死）。

---

## 六、文档/注释陈旧（4 条）

### E-1 改名残留：五处仍自称 KeepCompose `[已实测]`

- `src/styles/tokens.css:4`
- `src/styles/surface.css:2`
- `src/styles/app.css:2`
- `src/styles/fonts.css:2`
- `assets/builtin-skills/novel-writer/references/templates.md:1`（"# KeepCompose 文档协议参考"）
- 另：`src-tauri/capabilities/default.json:4` 的 description 为"KeepCompose 默认能力"

### E-2 同一个魔数在三处各写一遍 `[已实测]`

`4286343935`（旧版默认强调色）：`SettingsScreen.tsx` 的 `LEGACY_DEFAULT_ACCENT` 常量 + 同行十六进制注释 + `tools/e2e_chat.ps1` 里的字面量。

### E-3 四个审计脚本的"是否闸门"语义不统一 `[代码判定]`

`_a11y_check.py` / `_contrast_audit.py` 会 `exit 1`；`_style_audit.py` / `_css_coverage.py` **always exit 0** —— 后者无法作为闸门，却与前者并列同名。

### E-4 工具文档覆盖缺口 `[已实测]`

`AGENTS.md` / `docs/DEVELOPMENT.md` 只记录了 `package.ps1`、`capture.ps1`、`preview_*`、`ds_probe.py`、`mock_provider.py`、`e2e_*`；
**5 个 `_*.py` 审计脚本、`cdp_probe.py`、`uiwalk.ps1`、`probe_window.ps1`、`probe_win_style.ps1`、`_shot_flow.py` 没有任何文档入口**。

---

## 七、仓库状态（2 条）

### F-1 B10/B11 两批改动未提交 `[已实测]`

- `git log -1` = `a7edaf6`（**B9**）；工作区有 **19 个已改文件 + 4 个未跟踪文件**。
- 未跟踪：`src/core/store/onboarding.ts`、`src/ui/NewBookWizard.tsx`、`tests/ai/models.test.ts`、`tests/store/onboarding.test.ts`。
- 已改（部分）：`AGENTS.md`、`docs/KNOWN-LIMITS.md`、`src/screens/SettingsScreen.tsx`、`src/ui/MainWorkbench.tsx`、`src/styles/app.css`、`release/DeepCompose.exe` 等。
- **矛盾**：`AGENTS.md` / `KNOWN-LIMITS.md` 已按「已修（B10）」/「（B11）」口径书写 —— **产物是新的，仓库不是**；`git clean` 会丢两个新源文件。

### F-2 `KNOWN-LIMITS.md` 的定位与内容形态矛盾

同 I-11。

---

## 附：核对方式与复现入口

| 条目 | 复现方式 |
|---|---|
| A-2 | 在 `tests/` 下写入任意类型错误文件，跑 `.\node_modules\.bin\tsc.cmd --noEmit`，观察 exit 0 |
| A-1 | `Select-String -Path tools\_a11y_check.py,tools\_contrast_audit.py,tools\_shot_flow.py -Pattern 'nth-of-type'`，与 `SettingsScreen.tsx` 的 `navItems` 6 项对照 |
| A-4 | `git show HEAD:src/styles/glass.css`（exit 128） |
| A-5 | 读 `assets/builtin-skills/token-optimizer/scripts/duplicate_detect.py:61` |
| A-6 | `Select-String -Path src-tauri -Pattern 'remote-debugging\|WEBVIEW2\|9223' -Recurse`（零命中） |
| A-8 | `Select-String -Path . -Pattern 'builtin-skills' -Recurse`（仅 `README.md:74`） |
| B-3 | 对比 `session.ts:252` 与 `session.ts:275` |
| B-5 | 读 `SettingsScreen.tsx:1161/1165/1185/1189/1217/1221` |
| F-1 | `git status --short` 与 `git log --oneline -1` |
| 全套闸门 | `.\node_modules\.bin\tsc.cmd --noEmit`；`.\node_modules\.bin\vitest.cmd run`；`cd src-tauri; cargo test --lib` |

---

## 附：本文件的产生方式

- **通读范围**：`S:\DeepCompose` 全仓（文档 6 份、`src/` 全部 TS/TSX/CSS、`src-tauri/src/` 全部 Rust、`tests/` 30 个文件、`tools/` 18 个脚本、`assets/builtin-skills/` 13 个文件）。
- **实测动作**：跑三套闸门、注入类型错误验证 `tsc` 覆盖面、字节级检查文档编码、`git show` 验证基线、`Select-String` 验证选择器与引用、核对产物时间戳。
- **参照动作**：以该软件为一个真实作品（《李淑珍疑案》，5 卷 34 章 68 节）做完整导入，并在导入中记录协议层的可操作性问题（对应 I-1 ~ I-12）。
- **未做**：本文件**没有改动 DeepCompose 仓库中的任何文件**，也没有提出补丁。
