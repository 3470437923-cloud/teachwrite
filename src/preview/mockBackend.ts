/**
 * 预览后端替身（仅用于浏览器视觉验证，不进生产构建）。
 *
 * 用内存文件系统拦截 Tauri IPC（window.__TAURI_INTERNALS__.invoke），
 * 喂入示例作品 / 会话 / 配置，让 App 在纯浏览器里完整启动，
 * 供截图两主题。主题由 URL ?theme=dark|light 控制。
 */

import { GUIDE_SYSTEM, REVIEW_SYSTEM } from "../core/teaching/workflow";

const q = new URLSearchParams(location.search);
// 主题两套（dsblue 已于 2026-10-06 撤下）：?theme=dark|light，其余一律回落 dark
const THEME = q.get("theme") === "light" ? "light" : "dark";
// 可选夹具：?archived=1 表示预置作者已确认第5章归档；默认不确认，供验证归档门。
const ARCHIVED_FIXTURE = q.get("archived") === "1";
// 故障注入：?fail=prefs 让 prefs_load 抛错 —— 抛错走 boot() 的失败路径，
// 屏显的是 MainWorkbench 的「启动失败」屏（C-6：设置屏的「配置未加载」兜底页已随死代码删除，
// 不再有第二个故障形态）
const FAIL = q.get("fail") || "";
// 宣传片逐帧捕获用:?streamms=220 放慢 SSE 回放节奏(缺省 40ms,行为不变)
const STREAM_MS = Math.max(0, Number(q.get("streamms") || 40) || 40);
// 首启欢迎弹窗:?welcome=1 才在预览里弹(缺省视为已「不再显示」——
// 三主题截图与几何断言不该被一个模态挡住;要验收弹窗本身就带这个参数)
const WELCOME = q.get("welcome") === "1";

/**
 * 这里的 HOME / DOCUMENTS / APPDATA 是**纯夹具**：只给浏览器预览里的内存文件系统
 * 当"用户主目录"，不参与任何路径拼接断言，也不代表真实机器。
 *
 * 为什么可以保留 Windows 形态：本模块**只被 `src/preview/main.tsx` 引用**，
 * 而 `preview.html` 是 dev-only 入口 —— `vite.config.ts` 没有配
 * `build.rollupOptions.input`，所以生产构建只打 `index.html`（→ `src/main.tsx`），
 * 这个文件**不会进 Tauri 打包产物**（已实测：产物 JS 里搜不到 "Users\\Preview"）。
 * 预览跑在浏览器里（Chromium/Edge），用 `\` 当分隔符与 mock 的 norm() 口径一致，
 * 换成 `/` 反而会让部分 fixture 对不上。
 */
const HOME = "C:\\Users\\Preview";
const DOCUMENTS = `${HOME}\\Documents`;
const APPDATA = `${HOME}\\AppData\\Roaming`;
const PREFS_DIR = `${APPDATA}\\com.teachwrite.desktop`;
const PREFS_FILE = `${PREFS_DIR}\\shared_preferences.json`;
const BOOKS_ROOT = `${HOME}\\AI写小说`;
const SESSIONS_DIR = `${PREFS_DIR}\\writerd_sessions`;
const SNAPSHOTS_DIR = `${PREFS_DIR}\\writerd_snapshots`;
const SKILLS_DIR = `${PREFS_DIR}\\skills`;
const MEMOS_FILE = `${PREFS_DIR}\\writerd_memos.json`;

/* ── 内存文件系统 ── */
interface FNode { path: string; content: string; mtimeMs: number; }
const files = new Map<string, FNode>();       // 归一化路径 → 文件
const dirs = new Map<string, string>();        // 归一化路径 → 原始路径
const now = Date.now();
const DAY = 86400_000;

const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
const parentOf = (p: string) => {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i < 0 ? "" : s.slice(0, i);
};
const baseName = (p: string) => {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i < 0 ? s : s.slice(i + 1);
};

function ensureDir(path: string) {
  let cur = path.replace(/[\\/]+$/, "");
  const chain: string[] = [];
  while (cur && !dirs.has(norm(cur))) {
    chain.unshift(cur);
    const p = parentOf(cur);
    if (p === cur) break;
    cur = p;
  }
  for (const d of chain) dirs.set(norm(d), d);
}
function writeFile(path: string, content: string, mtimeMs = now) {
  ensureDir(parentOf(path));
  files.set(norm(path), { path, content, mtimeMs });
}
function readFile(path: string): string {
  const f = files.get(norm(path));
  if (!f) throw new Error(`读取失败 ${path}: 文件不存在`);
  return f.content;
}
function exists(path: string): boolean {
  return files.has(norm(path)) || dirs.has(norm(path));
}
function stat(path: string) {
  if (files.has(norm(path))) {
    const f = files.get(norm(path))!;
    return { isDir: false, size: new TextEncoder().encode(f.content).length, mtimeMs: f.mtimeMs, isLink: false };
  }
  if (dirs.has(norm(path))) return { isDir: true, size: 0, mtimeMs: now, isLink: false };
  return null;
}
/**
 * 删目录/文件（含子孙）。桌面端由 Rust fs_remove_child/fs_remove 完成；
 * 沙箱里必须同样"整棵子树一起走"，否则删掉作品后它的章节还会挂在列表里。
 */
function removeTree(path: string, recursive: boolean) {
  const n = norm(path);
  if (files.has(n)) {
    files.delete(n);
    return;
  }
  if (!dirs.has(n)) return;
  if (recursive) {
    for (const k of [...files.keys()]) if (k.startsWith(n + "/")) files.delete(k);
  }
  for (const k of [...dirs.keys()]) if (k === n || (recursive && k.startsWith(n + "/"))) dirs.delete(k);
}
/** 改名/搬家（目录连同子孙）。回收站的「移入」就是靠它把整部作品搬走。 */
function renameTree(from: string, to: string) {
  const fn = norm(from);
  const tn = norm(to);
  const fromOrig = from.replace(/[\\/]+$/, "");
  const toOrig = to.replace(/[\\/]+$/, "");
  const single = files.get(fn);
  if (single) {
    files.delete(fn);
    writeFile(to, single.content, single.mtimeMs);
    return;
  }
  if (!dirs.has(fn)) return;
  const relOf = (k: string) => k.slice(fn.length); // "" 或 "/章节内容/第1章.md"
  const movedFiles: { rel: string; node: FNode }[] = [];
  for (const [k, v] of [...files]) {
    if (k === fn || k.startsWith(fn + "/")) {
      movedFiles.push({ rel: relOf(k), node: v });
      files.delete(k);
    }
  }
  const movedDirs: string[] = [];
  for (const [k] of [...dirs]) {
    if (k === fn || k.startsWith(fn + "/")) {
      movedDirs.push(relOf(k));
      dirs.delete(k);
    }
  }
  for (const rel of movedDirs) dirs.set(tn + rel, toOrig + rel.replace(/\//g, "\\"));
  for (const { rel, node } of movedFiles) {
    files.set(tn + rel, { path: toOrig + rel.replace(/\//g, "\\"), content: node.content, mtimeMs: node.mtimeMs });
  }
  ensureDir(toOrig);
  void fromOrig;
}
interface DirEntry { name: string; rel: string; path: string; isDir: boolean; size: number; mtimeMs: number; }
function listDir(dir: string): DirEntry[] {
  const dn = norm(dir);
  const out: DirEntry[] = [];
  const seen = new Set<string>();
  for (const f of files.values()) {
    if (norm(parentOf(f.path)) !== dn) continue;
    const name = baseName(f.path);
    out.push({ name, rel: name, path: f.path, isDir: false, size: new TextEncoder().encode(f.content).length, mtimeMs: f.mtimeMs });
  }
  for (const [k, orig] of dirs) {
    if (norm(parentOf(orig)) !== dn) continue;
    const name = baseName(orig);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ name, rel: name, path: orig, isDir: true, size: 0, mtimeMs: now });
  }
  out.sort((a, b) => (a.isDir === b.isDir ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) : a.isDir ? -1 : 1));
  return out;
}

/* ── 种子：两部示例作品 ── */
function seedProject(name: string, chapters: string[], docs: Record<string, string>) {
  const root = `${BOOKS_ROOT}\\${name}`;
  ensureDir(`${root}\\小说资料`);
  ensureDir(`${root}\\章节内容`);
  for (const [doc, body] of Object.entries(docs)) writeFile(`${root}\\小说资料\\${doc}`, body, now - DAY * 2);
  chapters.forEach((c, i) => writeFile(`${root}\\章节内容\\第${i + 1}章.md`, c, now - (chapters.length - i) * 3600_000));
  writeFile(`${root}\\.openwrite_manifest.json`, JSON.stringify({ version: 1, displayName: name, order: [] }), now - DAY);
  return root;
}

const p1 = seedProject(
  "星海拾梦",
  [
    "# 第一章 潮汐信\n\n林砚第一次听见海在说话，是在十七岁那年的盛夏。\n\n那声音很轻，像是有人把一整夜的月光揉碎了，撒进浪里。他蹲在礁石上，指尖触到一枚会发光的贝壳，贝壳里躺着一段不属于这个世界的记忆。\n\n从那天起，他知道自己再也回不去从前了。",
    "# 第二章 拾梦人\n\n城里的人都叫他们「拾梦人」——那些能从海浪里捞起别人遗失梦境的人。\n\n林砚跟着老周学了三年，学会了分辨梦的重量：快乐的梦浮在水面，悲伤的梦沉在最深处，而那些被强行忘记的，会卡在礁石缝里，长成会发光的贝壳。",
    "# 第三章 雾港\n\n雾港是个连地图都懒得标注的地方。\n\n老周说，这里的雾不是水汽，是太多人不愿醒来的梦堆在一起，久了就成了雾。林砚不信，直到他在雾里看见了自己早已过世的母亲，正朝他招手。",
    "# 第四章 深渊来信\n\n那封信是从最深的海沟里浮上来的，信封上没有任何字迹，只有一枚会跳动的、像是心脏一样的封印。\n\n老周脸色变了：「三十年了，它终于又写信来了。」",
    "# 第五章 抉择\n\n林砚站在船头，手里握着那枚发光的贝壳。\n\n海在他脚下翻涌，像是无数双手在拉扯。他知道，只要把贝壳扔回去，就能换回母亲的性命——代价是，他要替她沉入那场永不醒来的梦。",
  ],
  {
    "世界观.md": "# 世界观\n\n故事发生在「潮汐纪」——一个梦境会随海水流动、沉积、发光的世界。\n\n- 梦有重量：快乐的梦上浮，悲伤的梦下沉，被遗忘的梦卡在礁缝里长成发光贝壳。\n- 拾梦人：能从海里捞起他人遗失梦境的特殊人群。\n- 雾港：未被标注的港口，雾是由不愿醒来的梦堆积而成。\n- 深渊：最深海沟，会「写信」，三十年一次。",
    "人物库.md": "# 人物库\n\n## 林砚\n主角，17 岁少年拾梦人。敏感、固执，为救母亲愿意付出一切。\n\n## 老周\n林砚的师父，苍老而神秘，似乎与深渊的来信有旧。\n\n## 母亲\n林砚早已过世的母亲，在雾港的雾中现身。她的死另有隐情。",
    "章节摘要.md": "# 章节摘要\n\n- 第一章：林砚听见海说话，捡到发光贝壳。\n- 第二章：介绍拾梦人与梦的重量。\n- 第三章：雾港，林砚在雾中见到亡母。\n- 第四章：深渊来信，老周色变。\n- 第五章：林砚面临抉择——用贝壳换母亲性命。",
    // D-045：风格通道对照用的档案（冷读面板 style 通道的沙箱样本）
    "06-写作风格.md": "# 06-写作风格\n\n## 风格规则\n\n- 叙述收在动作上，章尾不落在抽象总结。\n- 比喻贴身，不堆形容词。\n\n## 禁用列表\n\n- 非常\n- 十分\n- 不由自主地",
    "追踪-伏笔.md": "# 追踪-伏笔\n\n## 伏笔统计\n- 开放：2\n- 已回收：1\n- 废弃：0\n- 合计：3\n\n## F001\n- 内容与涉及对象：发光贝壳的来历与深渊的关系\n- 首次出现章节：第1章\n- 当前进展：林砚捡到贝壳，听见海说话\n- 预计触发或回收条件：深渊来信揭晓\n- 状态：开放\n- 来源与最近更新章节：第4章\n\n## F002\n- 内容与涉及对象：老周与深渊来信的旧约\n- 首次出现章节：第2章\n- 当前进展：老周看信后色变\n- 预计触发或回收条件：老周坦白\n- 状态：开放\n- 来源与最近更新章节：第4章\n\n## F003\n- 内容与涉及对象：母亲之死的隐情\n- 首次出现章节：第3章\n- 当前进展：雾中现身，未明言\n- 预计触发或回收条件：雾港真相揭晓\n- 状态：已回收\n- 来源与最近更新章节：第5章",
  },
);

seedProject(
  "雾都谍影",
  [
    "# 第一章 双面\n\n1943 年的雾都，连呼吸都是灰色的。\n\n苏文每天早晨在《申报》当校对，夜里则换上另一副面孔。没人知道，这个总低着头、说话轻声细语的女人，手里握着能让半座城颤抖的秘密。",
    "# 第二章 接头\n\n暗号是「今夜有雨」。苏文在咖啡馆角落坐下，对面的人推过来一杯加了双倍糖的红茶——那是自己人的记号。",
    "# 第三章 叛徒\n\n名单上有七个名字，其中一个是叛徒。苏文必须在天亮之前找出来，否则整条线都会暴露。",
  ],
  {
    "世界观.md": "# 世界观\n\n1943 年沦陷区雾都，谍战背景。多方势力交错，身份即武器。",
    "人物库.md": "# 人物库\n\n## 苏文\n女主，表面是报社校对，实为地下情报员。冷静、隐忍。\n\n## 陈默\n接头人，身份成谜。",
    "章节摘要.md": "# 章节摘要\n\n- 第一章：苏文的双重身份。\n- 第二章：咖啡馆接头。\n- 第三章：七人名单里的叛徒。",
  },
);

/* ── 种子：会话（跨今天/昨天/更早，验证下拉分组） ── */
function seedSession(id: string, title: string, projectPath: string, updatedMs: number, messages: unknown[]) {
  const body = { id, title, projectPath, createdAt: new Date(updatedMs - DAY).toISOString(), updatedAt: new Date(updatedMs).toISOString(), messages };
  writeFile(`${SESSIONS_DIR}\\${id}.json`, JSON.stringify(body), updatedMs);
  return { title, projectPath, createdAt: body.createdAt, updatedAt: body.updatedAt, userMessageCount: messages.filter((m) => (m as { role: string }).role === "user").length, size: JSON.stringify(body).length, mtimeMs: updatedMs };
}
const sessIndex: Record<string, unknown> = {};
sessIndex["s-1"] = seedSession("s-1", "第五章场景目标讨论", p1, now - 3600_000, [
  { id: "m1", role: "user", text: "请帮我梳理第五章的抉择场景，需要我自己想清楚哪些问题？", createdAt: new Date(now - 3600_000).toISOString() },
  { id: "m2", role: "assistant", text: "【预览模拟】先检查人物此刻的目标、可选择的代价和读者已经知道的依据。你可以自行决定场景结束时人物的认知或处境发生什么变化。我只提供判断问题，正文由你手写。", createdAt: new Date(now - 3500_000).toISOString() },
]);
sessIndex["s-2"] = seedSession("s-2", "检查人物设定依据", p1, now - 5 * 3600_000, [
  { id: "m1", role: "user", text: "怎样判断老周的年龄线索是否足够？", createdAt: new Date(now - 5 * 3600_000).toISOString() },
  { id: "m2", role: "assistant", text: "【预览模拟】请对照正文中的时间指向和人物库，区分作者已确定的事实与尚未揭示的信息。若读者目前不需要知道具体年龄，可以保留；需要补充时由你决定信息放在哪个场景。", createdAt: new Date(now - 4.9 * 3600_000).toISOString() },
]);
sessIndex["s-3"] = seedSession("s-3", "雾都谍影 年代依据核对", BOOKS_ROOT + "\\雾都谍影", now - DAY - 2 * 3600_000, [
  { id: "m1", role: "user", text: "请给我一个核对开篇年代感的检查方向，不要代改。", createdAt: new Date(now - DAY - 2 * 3600_000).toISOString() },
  { id: "m2", role: "assistant", text: "【预览模拟】核对器物、称谓、信息传递方式和人物获得消息的渠道是否符合时代。只检查影响当前场景的细节，再由你自行修改正文。", createdAt: new Date(now - DAY - 1.9 * 3600_000).toISOString() },
]);
sessIndex["s-4"] = seedSession("s-4", "章节重音自检", p1, now - 6 * DAY, [
  { id: "m1", role: "user", text: "本章最重要的场景该怎么判断？", createdAt: new Date(now - 6 * DAY).toISOString() },
  { id: "m2", role: "assistant", text: "【预览模拟】回看本章开始和结束时的处境差异，找到推动差异的关键选择。检查这一选择是否得到足够的动机与阻力支撑，再决定其余场景的篇幅。", createdAt: new Date(now - 6 * DAY + 60_000).toISOString() },
]);
writeFile(`${SESSIONS_DIR}\\index.json`, JSON.stringify({ version: 1, sessions: sessIndex }), now);

/* ── 种子：技能 ── */
writeFile(`${SKILLS_DIR}\\novel-writer\\SKILL.md`, "---\nname: novel-writer\ndescription: TeachWrite 作者指导：场景任务讨论、审读意见与资料回流，不生成正文、对白、示范或替代句。\n---\n", now - DAY * 3);
writeFile(`${SKILLS_DIR}\\worldbuilding\\SKILL.md`, "---\nname: worldbuilding\ndescription: 世界观构建：设计自洽的规则体系与冲突来源。\n---\n", now - DAY * 3);

/* ── 种子：备忘录 ──
   分类里必须**始终有「默认」**（界面里它没有 ×，即不可删；迁移目标也得存在），
   且不要用「全部」当分类名 —— 那是筛选栏的固定 chip，两个同名按钮看着像 bug。 */
writeFile(MEMOS_FILE, JSON.stringify({
  categories: ["默认", "灵感", "待办"],
  memos: [
    { id: "n0", title: "书名备选", category: "默认", content: "《拾梦者》《写信的人》《守梦人》—— 先记着，等写完第一卷再定。", project_id: p1, created_at: new Date(now - DAY).toISOString(), updated_at: new Date(now - DAY).toISOString() },
    { id: "n1", title: "深渊的来历", category: "灵感", content: "深渊不是海沟，是所有人集体潜意识的沉积层。每三十年「写信」，其实是在挑选一个新的守梦人。", project_id: p1, created_at: new Date(now - DAY).toISOString(), updated_at: new Date(now - DAY).toISOString() },
    { id: "n2", title: "补老周的过往", category: "待办", content: "第三章提到三十年前，需要在人物库补一句老周当年的经历，填时间线漏洞。", project_id: p1, created_at: new Date(now - 2 * DAY).toISOString(), updated_at: new Date(now - 2 * DAY).toISOString() },
  ],
}), now - DAY);

/* ── 种子：用量统计（`usage_stats.json`，标题栏用量面板的今日块读它） ──
   与真实文件同形：按本地日期分桶 + 最近一次余额快照。数值刻意留一组
   有缓存命中的样本（命中率高/低两种读法都能看出来）。 */
const dayKeyOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
writeFile(
  `${PREFS_DIR}\\usage_stats.json`,
  JSON.stringify({
    version: 1,
    days: {
      [dayKeyOf(new Date(now))]: {
        inputTokens: 128_400,
        outputTokens: 43_260,
        cacheHitTokens: 102_400,
        cacheMissTokens: 26_000,
        requests: 7,
      },
      [dayKeyOf(new Date(now - DAY))]: {
        inputTokens: 61_000,
        outputTokens: 18_000,
        cacheHitTokens: 0,
        cacheMissTokens: 61_000,
        requests: 3,
      },
    },
    lastBalance: {
      at: new Date(now - 3600_000).toISOString(),
      isAvailable: true,
      currency: "CNY",
      total: "42.18",
      granted: "0.00",
      toppedUp: "42.18",
    },
    lastError: null,
  }),
  now,
);

/* ── 配置 ── */
const seedPrefs: Record<string, unknown> = {
  "flutter.llm_base_url": "https://api.deepseek.com/v1",
  "flutter.api_key": "sk-preview-placeholder",
  "flutter.model": "deepseek-flash",
  "flutter.temperature": 0.8,
  "flutter.context_limit": 1000000,
  "flutter.custom_accent_color": 0, // 跟随主题（黑白灰）
  "flutter.is_dark_mode": THEME !== "light",
  "flutter.theme_mode": THEME,
  "flutter.current_novel_project": p1,
  "flutter.novel_projects": `${p1}\n${BOOKS_ROOT}\\雾都谍影`,
  "flutter.panel_show_directory": true,
  "flutter.panel_show_session": true,
  "flutter.chat_font_size": 15,
  "flutter.editor_font_size": 15,
  // 具名接口配置（B3 起设置页的主体）：两条 —— 一条带 id/platform（新形态），
  // 一条故意不带扩展字段（验证「老配置自动补 id/platform」的升级路径）
  "flutter.saved_providers": JSON.stringify([
    {
      name: "主力（DeepSeek 官方）",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-preview-placeholder-0001",
      model: "deepseek-flash",
      useAnthropicFormat: false,
      id: "p1a2b3c4",
      platform: "deepseek",
      thinking: true,
      reasoningEffort: "high",
    },
    {
      name: "硅基流动",
      baseUrl: "https://api.siliconflow.cn/v1",
      apiKey: "sk-preview-siliconflow",
      model: "deepseek-ai/DeepSeek-V3",
      useAnthropicFormat: false,
    },
  ]),
  "flutter.active_api_profile": "p1a2b3c4",
  "flutter.welcome_dismissed": !WELCOME,
};
// 归档仅是浏览器演示夹具，不代表 AI 或作者实际执行过归档。
if (ARCHIVED_FIXTURE) {
  const content = readFile(p1 + "\\章节内容\\第5章.md");
  writeFile(p1 + "\\writerd_oplog\\teachwrite\\第5章-归档.json", JSON.stringify({ chapter: 5, content, archivedAt: new Date(now).toISOString() }));
}

let prefsStore = JSON.stringify(seedPrefs);

/* 首启目录（boot 会 mkdir 这几个） */
for (const d of [BOOKS_ROOT, SESSIONS_DIR, SNAPSHOTS_DIR, SKILLS_DIR, PREFS_DIR]) ensureDir(d);

/* ── mock invoke ── */
const listeners = new Map<string, number>();  // `${event}|${id}` → transformCallback id
let evtSeq = 0;
const warned = new Set<string>();             // 未实现命令只告警一次
let winMaxed = false;                          // 沙箱里的窗口最大化状态

/** 向已注册的监听器派发事件（桌面端由 Rust 侧 emit；预览里手动触发，
 *  以便 onResized 之类的监听能被真实驱动，而不是永远不动） */
function emitMockEvent(event: string, payload: unknown) {
  for (const [key, handlerId] of listeners) {
    if (!key.startsWith(`${event}|`)) continue;
    const id = Number(key.split("|")[1]);
    callbacks.get(handlerId)?.({ event, id, payload });
  }
}

/** 只模拟传输与严格结构，不代表真实模型的生成质量或审读结论。 */
interface PreviewMessage { role?: unknown; content?: unknown }
interface PreviewBody { system?: unknown; messages?: PreviewMessage[] }
type PreviewChunk = { kind: string; data: string };
const streamTimers = new Map<string, ReturnType<typeof setTimeout>[]>();

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(block => block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "").join("\n");
}

function previewReply(body: PreviewBody): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = [contentText(body.system), ...messages.filter(m => m.role === "system").map(m => contentText(m.content))].join("\n");
  const user = contentText([...messages].reverse().find(m => m.role === "user")?.content);
  if (system.includes(GUIDE_SYSTEM)) {
    return JSON.stringify({ steps: [
      {
        title: "明确本章的场景目标",
        goal: "【预览固定导览】让作者确定当前人物在本章首先需要解决的问题。",
        actions: ["先列出人物当前目标，再选择本场景需要保留的阻力。", "用你自己的正文表现选择及其依据，不必解释全部背景。"],
        facts: ["以已确认正文与现有设定为依据，不把未确定的构想写成既成事实。"],
        turn: "检查人物面对阻力后是否需要改变原先的打算。",
        transition: "在本场景结束时留下下一场景需要处理的具体问题。",
        completion: "由作者自行判断：本场景的目标、阻力和选择是否足以被读者理解。",
      },
      {
        title: "展开冲突并检验信息依据",
        goal: "让人物的选择受到可理解的限制，推动本章的核心变化。",
        actions: ["核对人物当前知道和不知道的信息。", "亲自完成冲突段落，再检查变化是否来自此前的行动。"],
        facts: ["人物的能力、资源、位置和知情范围须与已确认资料连续。"],
        turn: "判断新信息是否真正改变人物的选择空间。",
        transition: "将冲突产生的后果交给最后一个场景承接。",
        completion: "由作者确认：因果依据与信息来源已经在自己的正文中得到必要表达。",
      },
      {
        title: "收束本章变化并准备审读",
        goal: "让读者看清本章前后的处境差异，保留下一章仍需解决的问题。",
        actions: ["回看开头的目标，判断本章已经解决与仍未解决的部分。", "自行写完章尾并通读全章，再决定是否发起审读。"],
        facts: ["不以固定字数判断场景完成；不根据导览预先更新追踪事实。"],
        turn: "检查章尾是否承接本章行动的实际后果。",
        transition: "本章由作者保存、审读和确认归档后，再生成下一章导览。",
        completion: "作者亲自确认本章导览任务已经完成；AI 不替代判断或勾选。",
      },
    ] });
  }
  if (system.includes(REVIEW_SYSTEM)) {
    const marker = "【作者正文，行号从1开始】\n";
    const index = user.lastIndexOf(marker);
    const source = index < 0 ? "" : user.slice(index + marker.length);
    const lines = source.split("\n");
    const at = lines.findIndex(line => line.trim() && !line.trimStart().startsWith("#"));
    if (at < 0) return "[]";
    const quote = Array.from(lines[at].trim()).slice(0, 24).join("");
    const style = user.includes("审读通道：风格与表达");
    return JSON.stringify([{
      category: style ? "预览·表达核对" : "预览·因果依据核对",
      quote,
      startLine: at + 1,
      problem: "【预览固定审读项】请核对这一段是否充分服务于当前场景目标；此项是界面演示，不是模型作出的质量结论。",
      basis: "浏览器模拟使用你提交的作者正文逐字定位，没有调用真实 API。",
      impact: "供演示问题定位、历史批次和作者手动采纳流程，不表示正文一定存在缺陷。",
      direction: style ? "由作者检查信息是否重复、语气是否与人物和视角一致，自行决定是否修改。" : "由作者对照场景目标与已确认事实，核对选择的动机和因果依据，自行决定是否修改。",
    }]);
  }
  if (system.includes("第一次阅读这部小说的普通读者兼审读员") || system.includes("你是一名文字校对")) {
    return "【无问题】\n【浏览器预览模拟】本次固定返回无问题用于演示冷读传输；这不代表真实审读结果，作者仍需自行判断。";
  }
  if (user.includes("【TeachWrite 正式正文资料回流】")) {
    return "【浏览器预览模拟】资料核对演示已结束，本次未提出任何文件修改。请亲自核对资料库，再决定是否确认归档；这不是对真实模型资料回流的验收。";
  }
  return "【浏览器预览模拟】可以先明确本章目标、人物当前动机、阻力和读者所需的信息，再由你亲自完成正文。请使用右侧教学入口生成正式导览或发起审读；本对话只提供指导，不生成正文、对白、示范或替代句，也不修改文件。";
}

function previewStream(body: PreviewBody): PreviewChunk[] {
  const text = previewReply(body);
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += 32) parts.push(text.slice(i, i + 32));
  const line = (payload: unknown): PreviewChunk => ({ kind: "line", data: "data: " + JSON.stringify(payload) });
  if (body.system !== undefined) {
    // Anthropic 兼容请求：保持事件格式，让预览也能走其实际解析器。
    return [
      line({ type: "message_start", message: { id: "preview", role: "assistant", model: "preview-fixture", content: [], usage: { input_tokens: 1200, output_tokens: 0 } } }),
      line({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      ...parts.map(part => line({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } })),
      line({ type: "content_block_stop", index: 0 }),
      line({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: Math.ceil(text.length / 2) } }),
      line({ type: "message_stop" }),
      { kind: "done", data: "" },
    ];
  }
  return [
    ...parts.map(part => line({ choices: [{ delta: { content: part } }] })),
    line({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    line({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: Math.ceil(text.length / 2), prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 400 } }),
    { kind: "line", data: "data: [DONE]" },
    { kind: "done", data: "" },
  ];
}

async function mockInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const S = (k: string) => String((args ?? {})[k] ?? "");
  switch (cmd) {
    case "app_dirs":
      return { home: HOME, documents: DOCUMENTS, appData: APPDATA, prefsDir: PREFS_DIR, prefsFile: PREFS_FILE };
    case "prefs_load":
      if (FAIL === "prefs") throw new Error("[preview] 故障注入：prefs_load 失败");
      return prefsStore;
    case "prefs_save":
      prefsStore = String((args ?? {}).json ?? "{}");
      return null;
    case "fs_mkdir":
      ensureDir(S("path"));
      return null;
    case "fs_list":
      return listDir(S("dir"));
    case "fs_read_text":
      return readFile(S("path"));
    case "fs_write_text":
      writeFile(S("path"), S("content"));
      return null;
    case "fs_append_text":
      writeFile(S("path"), (exists(S("path")) ? readFile(S("path")) : "") + S("content"));
      return null;
    case "fs_exists":
      return exists(S("path"));
    case "fs_stat":
      return stat(S("path"));
    case "fs_remove":
      removeTree(S("path"), Boolean((args ?? {}).recursive));
      return null;
    case "fs_remove_child":
      // 对齐 Rust fs_remove_child：父目录 + 单个路径段（名字校验在 Rust/recycle 层）
      removeTree(`${S("parent")}\\${S("name")}`, Boolean((args ?? {}).recursive));
      return null;
    case "fs_rename":
      renameTree(S("from"), S("to"));
      return null;
    case "fs_copy": {
      const f = files.get(norm(S("from")));
      if (f) writeFile(S("to"), f.content, f.mtimeMs);
      return null;
    }
    case "ai_stream": {
      const req = ((args ?? {}).request ?? {}) as { requestId?: string; body?: PreviewBody };
      const id = String(req.requestId ?? "");
      if (!id) return null;
      for (const timer of streamTimers.get(id) ?? []) clearTimeout(timer);
      const script = previewStream(req.body ?? {});
      const timers = script.map((chunk, i) => setTimeout(() => {
        emitMockEvent("ai_chunk", { requestId: id, kind: chunk.kind, data: chunk.data });
        if (chunk.kind === "done") streamTimers.delete(id);
      }, STREAM_MS * (i + 1)));
      streamTimers.set(id, timers);
      return null;
    }
    case "ai_abort": {
      const id = S("requestId");
      for (const timer of streamTimers.get(id) ?? []) clearTimeout(timer);
      streamTimers.delete(id);
      return null;
    }
    // 应用身份（桌面端为 Rust app_info）：设置屏「关于」的名称/版本取自这里
    case "app_info":
      // 署名与社群字段与 Rust app_info 同形(B19/D-053):预览里帮助页脚、关于页
      // 作者卡、首启弹窗都走真实渲染路径(不是空壳)
      return {
        name: "TeachWrite",
        version: "0.1.0",
        author: "Liumorrow",
        copyright: "Copyright © 2026 Liumorrow",
        qqGroup: "1071188925",
        douyinUrl: "https://v.douyin.com/cKG2h8pU1IM/",
        build: "preview-sandbox",
      };
    // 目录选择器（plugin-dialog）：沙箱里返回 null = 用户取消，正好验证取消分支
    case "plugin:dialog|open":
      return null;
    // 打开目录（自研 Rust 命令）：沙箱无资源管理器，静默成功即可
    case "open_dir":
      return null;
    // 打开外部链接(桌面端 Rust open_url):沙箱没有浏览器,静默成功即可
    case "open_url":
      return null;
    // 网页版参考栏（D-057 桌面端 Rust 命令）：沙箱里没有子 webview，
    // 栏的 DOM 与几何同步照常跑，只有"网页本体"不存在 —— 栏位显示提示区与空宿主。
    case "web_open":
    case "web_move":
    case "web_close":
      return null;
    // 模型清单（桌面端走 Rust ai_models → OpenAI/Anthropic /models）；
    // 返回 DeepSeek 官方文档当前的模型名，供设置屏「检测连接」走真实渲染路径
    case "ai_models":
      return ["deepseek-flash", "deepseek-v4-pro"];
    // 余额（DeepSeek 官方 GET /user/balance）：沙箱返回固定值，
    // 让鲸鱼信息面板能在预览里走真实渲染路径（[待实测] 的是真机联调，不是这里）
    case "ai_balance":
      return {
        isAvailable: true,
        balances: [
          { currency: "CNY", totalBalance: "42.18", grantedBalance: "0.00", toppedUpBalance: "42.18" },
        ],
      };
    // 窗口命令（@tauri-apps/api/window）：浏览器沙箱里没有真实窗口，但返回值必须
    // **诚实** —— 早先未实现时统一返回 null，会让标题栏「最大化」按钮永远显示
    // 未最大化（按钮图标/提示就是无边框窗口唯一的状态反馈）。
    case "plugin:window|is_maximized":
      return winMaxed;
    case "plugin:window|is_minimized":
    case "plugin:window|is_fullscreen":
      return false;
    // 最大化状态在沙箱里也要**真的变**，否则标题栏按钮的「最大化 ⇄ 向下还原」
    // 切换没法在预览里验证（桌面端由 Windows 改状态，这里由这几条命令改）
    case "plugin:window|maximize":
      winMaxed = true;
      emitMockEvent("tauri://resize", { width: 1920, height: 1032 });
      return null;
    case "plugin:window|unmaximize":
      winMaxed = false;
      emitMockEvent("tauri://resize", { width: 1440, height: 900 });
      return null;
    case "plugin:window|toggle_maximize":
      winMaxed = !winMaxed;
      emitMockEvent("tauri://resize", winMaxed ? { width: 1920, height: 1032 } : { width: 1440, height: 900 });
      return null;
    case "plugin:window|minimize":
    case "plugin:window|close":
    case "plugin:window|destroy":
    case "plugin:window|show":
    case "plugin:window|set_size":
    case "plugin:window|set_position":
    case "plugin:window|center":
    case "plugin:window|start_dragging":
    case "plugin:window|start_resize_dragging":
      return null;
    // 事件插件（@tauri-apps/api/event）：桌面端由 Rust 侧注册回调并返回 eventId
    case "plugin:event|listen": {
      const event = S("event");
      const id = ++evtSeq;
      listeners.set(`${event}|${id}`, Number((args ?? {}).handler ?? 0));
      return id;
    }
    case "plugin:event|unlisten": {
      listeners.delete(`${S("event")}|${Number((args ?? {}).eventId ?? 0)}`);
      return null;
    }
    default:
      // 未实现命令：仍然静默成功，但留痕 —— 替身不许悄悄撒谎
      if (!warned.has(cmd)) {
        warned.add(cmd);
        console.warn("[preview] 未实现命令，已返回 null：", cmd);
      }
      return null;
  }
}

/* ── 安装到 window.__TAURI_INTERNALS__（@tauri-apps/api v2 的注入点） ── */
let cbId = 0;
const callbacks = new Map<number, (e: unknown) => void>();
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  invoke: mockInvoke,
  transformCallback: (cb: (e: unknown) => void, once = false) => {
    const id = ++cbId;
    callbacks.set(id, once ? (e) => { callbacks.delete(id); cb(e); } : cb);
    return id;
  },
};
// @tauri-apps/api/event 的 _unlisten 直接读这个全局对象（桌面端由 Rust 注入），
// 缺了它 → listen 的清理函数一调用就 TypeError，整棵 React 树会被卸载
(window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: (event: string, eventId: number) => {
    listeners.delete(`${event}|${eventId}`);
  },
};
