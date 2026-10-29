---
name: DeepCompose
description: AI 小说写作工作台 —— 以「付印单」为世界观的实色三栏工作台
colors:
  accent-ink: "#8a919c"
  accent-fill: "#787f8b"
  accent-text: "#e9ecf2"
  accent-deep: "#4e5560"
  canvas: "#0a0e17"
  canvas-deep: "#0d1220"
  rail: "#111726"
  sheet: "#151c2c"
  raised: "#1b2336"
  well: "#0d1320"
  text-primary: "#e8ecf5"
  text-secondary: "#b0bacf"
  text-tertiary: "#8a95ac"
  text-dim: "#8b96ad"
  hairline: "rgba(150, 175, 255, 0.13)"
  hairline-soft: "rgba(150, 175, 255, 0.07)"
  hairline-strong: "rgba(150, 175, 255, 0.26)"
  success: "#3ecf95"
  danger: "#ff7a85"
  warning: "#e0b055"
typography:
  display:
    fontFamily: "Inter Variable, MiSans VF, -apple-system, Segoe UI Variable Text, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "23px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.022em"
  title:
    fontFamily: "Inter Variable, MiSans VF, -apple-system, Segoe UI Variable Text, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.016em"
  body:
    fontFamily: "Inter Variable, MiSans VF, -apple-system, Segoe UI Variable Text, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "0.004em"
  reading:
    fontFamily: "MiSans VF, Inter Variable, PingFang SC, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.95
    letterSpacing: "0.012em"
  label:
    fontFamily: "Inter Variable, MiSans VF, -apple-system, Segoe UI Variable Text, Microsoft YaHei UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 560
    lineHeight: 1.4
    letterSpacing: "0.012em"
rounded:
  xs: "2px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "10px"
spacing:
  pad: "9px"
  gap: "9px"
  files-pane: "236px"
  chat-pane: "400px"
  titlebar: "50px"
  statusbar: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent-fill}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "#5a71e4"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "32px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "32px"
  field:
    backgroundColor: "{colors.well}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    padding: "0 11px"
    height: "32px"
  chip:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.xs}"
    padding: "0 9px"
    height: "24px"
  panel:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
  tab-active:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    height: "34px"
  tree-node:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.xs}"
    height: "26px"
  tree-node-selected:
    backgroundColor: "{colors.accent-fill}"
    textColor: "#ffffff"
---

# Design System: DeepCompose

## Overview

**Creative North Star: 「付印单」(The Proof Slip)**

DeepCompose 是一个要连续盯几个小时的写作台，所以它的视觉世界不是"氛围"，而是**一张印厂的校样流转签**：稿件在几个工位之间流转，每一次交接都要在签上留下痕迹——谁碰过、到哪一步、是否已过签。整个界面就是那张签。

这决定了三件事。第一，**没有材质，只有纸**。全屏零渐变、零背景模糊、零彩色光晕，面板一律不透明。层级不靠投影和透明度，靠**明度阶梯**：画布 → 侧轨 → 纸面 → 抬升面，外加一个反向的"井"（输入区）。编辑器那一栏是整屏最亮的一级，因为它就是那张纸。第二，**状态用线形说，不用色相说**。实线 = 已落盘，虚线 = 有未落盘改动，半高 = 陈旧，划掉 = 禁用。一套线形词汇就能覆盖状态，颜色因此被腾出来只做两件事。第三，**强调墨极其吝啬**。整屏只有两处允许出现强调色：**当前所在的位置**，和**唯一的主操作**。其余一切——分类标签、徽标、图标、日期——都必须是中性的。用户换强调色时全站联动，但联动的东西很少，这正是不让它变廉价的原因。

**Key Characteristics:**
- 实色五级明度阶梯承载层级；零模糊、零渐变、零光晕（审计脚本按元素逐个验证过）
- 状态由**线形**表达（实/虚/半高/划掉），不由色相表达
- 强调色只出现在"当前位置"与"主操作"两处
- 紧半径（结构件 ≤8px）；真圆只留给本来就是圆的东西（开关轨道、滑杆钮）
- 动效预算 150–250ms，只表达状态变化；唯一一处编排动效是流式生成时那条**行进线**
- 字距随字号反向（大字收紧、小字放款）
- 两套主题（曜石黑 / 晨雾白）是同一套阶梯的两种明度解，不是两种风格（DS 蓝已于 2026-10-06 撤下：只留黑白，强调色默认「跟随主题」的黑白墨）

## Colors

一套石墨阶 + 主题自带的黑白强调墨。浅色主题刻意走**冷灰**，不走"中国写作软件"默认的暖米黄纸感——那是本项目明确拒绝的默认皮肤。2026-10-06 起（用户裁决）品牌蓝退出界面：强调色默认「跟随主题」——暗色主题用近白墨（#E9ECF2），浅色主题用近黑墨（#14171B），设置页色板只有灰阶。

### Primary
- **主题墨 / accent-ink**: 强调色本体。默认跟随主题（暗 = 近白、浅 = 近黑）。只用于发丝级标记、当前状态的下划线、非文字图形。**不作为大面积填充**。
- **实心墨 / accent-fill**: 实心块的填充色，由 color-mix 从 accent 压暗派生。
- **浅墨文字 / accent-text**: 强调色当文字用时（暗色主题）。浅色主题下由 `color-mix` 压暗至 4.5:1 以上。
- **on-accent**: 强调色实心块上的文字色，由 core/app.ts 按强调色亮度翻转（白墨配近黑字、黑墨配白字）。

### Neutral
- **画布 / canvas** (`#0a0e17`): 窗外底色。全屏唯一一档底色，**不是渐变**——底色一旦有渐变，面板的明度差就失去参照。
- **侧轨 / rail** (`#111726`): 文件栏、对话栏、设置导航栏。
- **纸面 / sheet** (`#151c2c`): 编辑器。整屏最亮的结构面，因为它就是那张纸。
- **抬升面 / raised** (`#1b2336`): 真正浮起的层——菜单、模态、错误卡。
- **井 / well** (`#0d1320`): 反向凹槽。输入框、思考过程、标题栏里的控件簇。
- **文字四级** `#e8ecf5` / `#b0bacf` / `#8a95ac` / `#8b96ad`: 最低一级也承载真实内容（日期、状态栏、思考过程），因此四级全部过 4.5:1。
- **发丝线三级** `rgba(150,175,255,.13/.07/.26)`: 默认分隔 / 轻分隔 / 聚焦框。

### Named Rules
**The Two-Ink Rule.** 强调色在一屏里最多出现两次：当前所在的位置，和唯一的主操作。分类标签、徽标、日期、图标一律中性——强调色一旦被分类标签分掉，就再也读不出"哪个是选中的、哪个是主按钮"。

**The State-Not-Hue Rule.** 状态由线形承担：实线已落盘、虚线未落盘、半高陈旧、划掉禁用。颜色不参与状态表达，因此状态在色觉缺陷下依然成立。

**The Flatness Rule.** 零渐变、零 `backdrop-filter`、零彩色光晕。发光属于装饰而非深度，且会与内容抢注意力。这条由 `tools/_a11y_check.py` 的扁平度审计逐元素（含 `::before`/`::after`）强制。

## Typography

**Display Font:** Inter Variable（拉丁与数字）+ MiSans VF（汉字），系统栈兜底
**Body Font:** 同上
**Reading Font:** MiSans VF 优先——正文是汉字，先给汉字字体

**Character:** 无衬线、中性、可长时间阅读。字号阶梯刻意做得密（档间比 1.15–1.27）：产品界面里档位多而对比不能夸张，否则密集的标签会长成一片噪音。真正的表现力交给**字距**和**行距**，不交给字号跳跃。

### Hierarchy
- **Display** (700, 23px, 1.25, -0.022em): 空态品牌名、模态标题。一屏至多一处。
- **Title** (700, 19px, 1.3, -0.016em): 文档标题、设置卡片标题。
- **Headline** (660, 15px, 1.4, -0.008em): 面板标题、备忘录标题。
- **Body** (400, 14px, 1.6, 0.004em): 界面正文。
- **Reading** (400, 16px, **1.95**, 0.012em): 编辑器正文。行距 1.95 是护眼取舍——这是要连读几小时的文本，不是 UI 文案。
- **Label** (560, 12px, 1.4, 0.012em): 按钮、胶囊、状态文字。
- **Caption** (620, 11px, 0.02em): 日期、徽标、页脚计数。用 11px 而非 10px：再小就压不住 4.5:1。

### Named Rules
**The Optical Tracking Rule.** 字距随字号反向：23px 用 -0.022em，14px 用 +0.004em，11px 用 +0.02em。大字不收会散，小字不放会糊。

**The Character-Measure Rule.** 正文版心用**字符数**表达（`--editor-measure-chars: 42`），由字号换算成绝对长度。绝不能写成 `42em`——自定义属性按原样替换，`em` 会被每个元素按自己的字号解释，于是标题和正文的左边缘会差 21px。

## Layout

三栏工作台：**左 = 文件**（作品选择 + 目录树，236px）· **中 = 编辑器** · **右 = AI 对话**（400px）。左右两栏可各自收起；收起时面板立即从焦点序列与无障碍树中移除（`inert` + `aria-hidden`），CSS 的 `visibility: hidden` 延迟 240ms 生效，两者互补。

左栏目录树固定保留三类内容，它们同时是磁盘上的三个目录，类别由路径决定：**小说资料 / 章节内容 / 待确认**。

**空间语法**：统一 `--pad: 9px` 面板内边距、`--gap: 9px` 面板间距。面板之间靠 9px 画布底色 + 各自 1px 发丝线分界，**不靠投影**。标题栏 50px、状态条 32px，都是固定值而非流体——这是固定 DPI 的桌面窗口，不是响应式网页。

**密度**：默认紧凑。列表行高 26px，控件高 32px，胶囊 24px。密度是这个产品的功能，不是风格。

**设置屏有栏宽上限**（860px，居中）。不设上限时表单卡片会横跨 1400px，输入框长到一行能放下整段 URL，读数时眼睛要横穿整屏——正文栏宽是排版最基本的约束，设置屏同样是"正文"。

**降级**：1024×700 到 1600×1000 全部无横向/纵向溢出、无底部空隙。窄窗下左右两栏可收起，编辑器始终占满剩余宽度。

## Elevation & Depth

**不用投影表达层级**。层级由**明度阶梯**承担：`canvas → rail → sheet → raised`，外加反向的 `well`。抬升面（菜单、模态）是唯一使用投影的地方——它确实浮在别的层**之上**，投影在这里是信息不是装饰。

### Shadow Vocabulary
- **抬升层** (`var(--sh-1)` + `var(--sh-2)` 两段): 只给菜单、模态、错误卡。必须有偏移量。
- **模态遮罩** (`var(--scrim)`): 实色压暗，浅色主题 `rgba(20,24,30,.34)`，暗色主题 `rgba(0,0,0,.62)`。它**不是**靠模糊背景来实现"后面的内容退后"。
- **井内描边** (`box-shadow: inset 0 0 0 1px var(--well-line)`): 输入框与思考过程的凹陷感，不占用布局空间。

### Named Rules
**The Brightness-Carries-Hierarchy Rule.** 层级只由明度差表达。想强调一个面，就在阶梯上给它一个位置，不要给它投影。

**The Honest Shadow Rule.** 投影必须有偏移 + 柔和模糊。零偏移的彩色光晕是装饰，不是深度，一律禁用。同一屏幕上不允许出现"硬偏移阴影"（那是贴纸感）。

**The One-Material Rule.** 面板一律不透明。任何位置出现 `backdrop-filter` 都是回归。

## Shapes

**紧半径，器械感。** 印刷表单的角是方的；圆角只用来表达"这是个可点的件"，不用来卖萌。旧体系最大圆角 20px，收到 10px 上限后整屏气质从"泡泡"变成"器械"。

- **2px (`xs`)**: 印章与登记标——树节点、分类标签、徽标。接近直角。
- **4px (`sm`)**: 控件。按钮、输入框、页签。
- **6px (`md`)**: 卡片。
- **8px (`lg`)**: 面板。
- **10px (`xl`)**: 模态框。
- **999px (`full`)**: **只给本来就是圆的东西**——开关轨道、滑杆钮。不用它包按钮。

**边界**：所有分界都是 1px 发丝线。发丝线是这套体系的**主结构语言**——面板边界、行分隔、选中下划线、状态标记全用它。**没有超过 1px 的彩色边条**（曾经的 `border-left: 2px` 强调条已全部拆除，改为"井"或下划线）。

## Components

### Buttons
- **Shape:** 4px 圆角，高 32px，左右 14px 内边距。
- **Primary:** `accent-fill` 填充 + 白字。**全屏唯一允许的实心强调色块**。悬停提亮 12%，按下 `scale(0.975)`。
- **Outline:** 透明底 + `--ctl-fill` 静止底色 + 1px 发丝线。绝大多数按钮都是这一档。
- **Danger:** 透明底 + **危险色文字** + 危险色描边。**不给实心红**——实心红块在一屏里只能有一个语义（真的按下去了），否则就廉价了。悬停铺 9% 危险色浅底。
- **Quiet:** 无描边，只有悬停时出现 `--ctl-fill`。用于面板头部的工具按钮。
- **Hover / Focus:** 悬停 120ms 换底色；指针聚焦 1.5px 强调色描边，键盘聚焦（`:focus-visible`）2px 实心环 + 3px 柔光。两级**不混用**。

### Chips
- **Style:** 24px 高，2px 圆角，`--ctl-fill` 底 + 发丝线，`tx-2` 文字。
- **State:** 选中态换 `accent-soft` 底 + `accent-text` 文字。警告态用 `--warn` 文字（如"未配置 API Key"）。

### Cards / Containers
- **Corner Style:** 6px。
- **Background:** 画布上为 `rail`，纸面上为透明 + 发丝线。
- **Border:** 1px `var(--line)`。**没有投影**。
- **Internal Padding:** 14px。

### Inputs / Fields
- **Style:** `well` 底色（比周围暗一档）+ 1px `--well-line` 内描边 + 4px 圆角。
- **Focus:** 指针聚焦 1.5px 强调色描边；不用发光。
- **Placeholder:** `tx-dim`，实测 ≥4.5:1（浅色主题下曾只有 4.05:1，已把这级文字压深）。
- **Disabled:** `opacity: .45`，且不响应 `:active`。

### Navigation
- **设置导航**：224px 侧轨，行高 30px，4px 圆角。选中态 **accent-soft 底 + accent-text 文字**——是浅染而非实心填充（实心填充留给真正的"当前位置"标记，如当前文档页签）。
- **文档页签**：选中态**不加底色**，只加一条 2px 强调色**下划线**。底色的稀缺性正是它可读的原因。

### Signature: 行进线 (The Runner)
流式生成时，对话面板**上缘**出现一条 2px 实心强调色短线，自左向右跑动（`@keyframes stream-run`，translateX −100% → 295%，1.25s，**纯 transform**）。这是全 app 唯一一处编排动效。它替代了旧版那条 conic-gradient 旋转光晕 + 呼吸径向光晕——两者都是零偏移彩色光晕，属于装饰。`prefers-reduced-motion` 下它变成一条**整宽的静止实线**：动效没了，状态还在。

### Signature: 过签线 (The Stamp Line)
状态条右侧的保存态是一条 20×2px 的短线：**实线 = 已落盘，虚线 = 有未落盘改动**。每次保存态改变时这个元素被重建（JSX 用 `key` 驱动），于是那条线会自左向右重新"划"出来一次（`stamp-draw`，纯 `scaleX`）。它右侧永远跟着文字（"未保存 · Ctrl+S 保存"），所以状态从不只靠颜色或线形单独承担。

## Do's and Don'ts

### Do:
- **Do** 想强调一个面时，在明度阶梯上（`canvas → rail → sheet → raised`）给它一个位置。
- **Do** 用线形表达状态：实线已落盘、虚线未落盘、半高陈旧、划掉禁用。
- **Do** 把强调色留给"当前位置"与"唯一主操作"两处。
- **Do** 给文字色定 4.5:1 的门槛，并用 `tools/_contrast_audit.py` 实测真实元素（沿祖先链做 alpha 合成），不要靠估算。
- **Do** 用 `tools/_a11y_check.py` 逐元素（含伪元素）验证零 `backdrop-filter`、零渐变、零 `filter: blur()`。
- **Do** 把动效压在 150–250ms，并且只表达状态变化。
- **Do** 同时验两套主题。两套主题的令牌定义在 `:root` 与 `html[data-theme="…"]` 两处、特异性不同——曾经有一个 `@media (prefers-contrast)` 块只写 `:root`，对 light/dark 完全失效，只在默认主题上验会漏掉它。

### Don't:
- **Don't** 用渐变、`backdrop-filter`、或彩色光晕表达深度。零偏移的彩色光晕是装饰，不是深度。
- **Don't** 给文字上渐变（`background-clip: text`）——强调靠字重与字号。
- **Don't** 用超过 1px 的彩色 `border-left/right` 当强调条。
- **Don't** 把实心强调色块用在同一屏的多个按钮上。实心块在一屏里只有一个语义。
- **Don't** 用分类标签、徽标、日期消耗强调色。
- **Don't** 把层级交给 `rgba` 透明度叠加。五级阶梯是实色——文字落点必须确定。
- **Don't** 在设置屏取消栏宽上限。
- **Don't** 改 `theme_mode` 的两个字符串值（`dark`/`light`）。它们是磁盘格式，已经写进用户配置文件里；只能改显示名，不能改值。（旧值 `dsblue` 已于 2026-10-06 随主题撤下退出——旧配置读到它在 parsePrefs 迁移为 `dark`。）