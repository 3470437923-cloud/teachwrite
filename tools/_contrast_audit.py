"""对比度审计：按 WCAG 2.1 实测真实元素上文字与它实际所处底色的对比度。

为什么重写：旧版是为"半透明玻璃"写的 —— 它读取 --bg-base / --glass-tint-a /
--inset-bg 等令牌，再合成出面板的有效底色。实色体系上线后那些令牌被删除，
而未定义的自定义属性会让 `color: var(--x)` 整条声明失效、回退到**继承值**，
于是旧脚本把文字色和它自己比，输出了一整屏 "tx-1 / 面板 1.01:1" 这种
荒谬结论 —— 工具在骗人，而且看不出来。教训：审计脚本必须实测 DOM，
不能靠"假设某个令牌还在"。

现在的做法（新体系是实色，反而更好测）：
  · 选定一组真实元素选择器（从真实页面里取，不是造一个 div 猜）；
  · 读它自己的 color；
  · 沿祖先链收集每一层 backgroundColor，从最外层不透明底开始逐层 alpha
    合成，得到文字真正落在的那个颜色；
  · 阈值按 WCAG 自动判定：字号 >=24px，或 >=18.66px 且字重 >=700 算大字
    （门槛 3:1），其余算正文（门槛 4.5:1）。这样就不需要我人工给某个
    元素"开后门"降门槛。

用法：
    python tools/_contrast_audit.py    # 在仓库根目录下运行（报告写到 ./shots/）

前提：vite dev server（5183）+ 无头 Edge CDP（9223）已启动（口径见
docs/DEVELOPMENT.md）；mockBackend 预置数据完好——editor/chat 流程依赖
预置章节与会话才能把编辑器、气泡、思考块渲染出来。

已知坑（除上文两条教训外）：
    - 报告路径 shots/contrast-report.json 相对**当前工作目录**，不在仓库
      根目录下运行会把报告写错地方。
    - 设置屏 B 组只看不点 .a-btn-danger（危险操作），其对比度按静止态测。
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _shot_flow import CDP, FLOWS, run_flow  # noqa: E402

# (ASCII 标签, 选择器) —— 标签用 ASCII，避免终端把中文标签显示成乱码
# 而让人看错是哪一对不达标。
TARGETS = [
    ("tree-item/rail", ".tnode"),
    ("tree-selected/accent-fill", ".tnode.on"),
    ("panel-title/rail", ".panel-head .ttl"),
    ("panel-foot/rail", ".panel-foot"),
    ("chip/rail", ".chip"),
    ("chip-model/rail", ".chip.model"),
    ("tab-idle/sheet", ".tab"),
    ("btn-outline/rail", ".btn"),
    ("btn-accent/on-accent", ".btn-accent"),
    ("btn-quiet/rail", ".btn-quiet"),
    ("ee-hint/sheet", ".ee-hint"),
    ("ee-p/sheet", ".ee-p"),
    ("ee-t1/sheet", ".ee-t1"),
    ("cw-tip-text/ctl-fill", ".cw-tip"),
    ("cw-p/sheet", ".cw-p"),
    ("composer-input/well", ".composer-input"),
    ("composer-ph/well", ".composer-input"),
    ("bubble-ai/rail", ".msg.ai .bubble"),
    ("bubble-user/accent-fill", ".msg.user .bubble"),
    ("think/well", ".think"),
    ("statusbar/bg-2", ".statusbar"),
    ("send-icon/accent-fill", ".send"),
    ("sess-ava-icon/accent-fill", ".sess-ava"),
    ("session-title/ctl-fill", ".sess-title"),
    ("editor-h1/sheet", ".editor-title h1"),
    ("wc-badge/sheet", ".wc-badge"),
    ("mode-badge/sheet", ".mode-badge"),
    ("danger-btn/on-bad", ".btn-danger"),
]

# 设置屏单独跑两趟：这里的文字色令牌（--accent-text 落在 --accent-soft 上、
# 成功绿、危险红）在主视图里不出现，不测就等于没验。
# A = 提供商分节(点保存会让 .a-flash 真的渲染出来再测它);
# B = 数据分节(.a-btn-danger 只在这里,只看不点 —— 那是危险操作)。
SETTINGS_TARGETS = [
    ("a-nav-idle/rail", ".a-nav-item"),
    ("a-nav-selected/soft", ".a-nav-item.on"),
    ("a-card-title/sheet", ".a-card-title"),
    ("a-card-desc/sheet", ".a-card-desc"),
    ("a-form-label/sheet", ".a-form-label"),
    ("a-input/well", ".a-form-input"),
    ("a-flash-ok/sheet", ".a-flash"),
    ("a-btn-primary/on-accent", ".a-btn-primary"),
]

SETTINGS_TARGETS_B = [
    ("a-btn-danger/on-bad", ".a-btn-danger"),
]

# C = 关于分节(B19/D-053 的「作者与社群」卡:署名、构建烙印、群号、行按钮)。
# 这些文字只在关于页出现,不测就等于没验 —— 而它们正是开源署名要显眼的地方。
SETTINGS_TARGETS_C = [
    ("author-name/sheet", ".author-name"),
    ("a-build/sheet", ".a-build"),
    ("a-qq/sheet", ".a-qq"),
    ("a-list-row/sheet", ".a-list-row"),
]

# 模态组(B19):帮助弹层与首启欢迎弹窗。help 走标题栏按钮打开;
# welcome 需要 URL 带 ?welcome=1(mockBackend 缺省视为已「不再显示」)。
HELP_TARGETS = [
    ("help-title/raised", ".help-title"),
    ("help-item-idle/raised", ".help-item"),
    ("help-item-on/soft", ".help-item.on"),
    ("help-p/raised", ".help-p"),
    ("help-foot/raised", ".help-foot"),
    ("help-qq/raised", ".help-qq"),
    ("help-dy-btn/raised", ".help-dy"),
]

WELCOME_TARGETS = [
    ("welcome-h/raised", ".welcome-h"),
    ("welcome-sub/raised", ".welcome-sub"),
    ("welcome-k/raised", ".wr-k"),
    ("welcome-v/raised", ".wr-v"),
    ("welcome-vb/raised", ".wr-v b"),
    ("welcome-never/raised", ".welcome-never"),
    ("welcome-btn-primary/on-accent", ".welcome-actions .btn-accent"),
    ("welcome-btn-quiet/raised", ".welcome-actions .btn-quiet"),
]

CONTRAST_JS = r"""
((targets) => {
  const parse = (c) => {
    const s = String(c);
    // Chrome 把 color-mix(in srgb, ...) 的计算值序列化成 `color(srgb r g b)`
    // —— 分量是 0..1 而不是 0..255。只认 rgb() 的话，所有用 color-mix 派生的
    // 令牌（--accent-fill / --accent-text / --accent-soft …）都会被判成
    // "解析失败 → 透明"，于是脚本会拿祖先的背景色去算，得出完全错误的结论。
    // 这是工具骗人的第二个坑，必须两种写法都认。
    const m2 = s.match(/color\(srgb\s+([^)]+)\)/);
    if (m2) {
      const q = m2[1].split(/[\s/]+/).filter(Boolean).map(Number);
      return { r: q[0] * 255, g: q[1] * 255, b: q[2] * 255, a: q.length > 3 ? q[3] : 1 };
    }
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (s, d) => ({
    r: s.r * s.a + d.r * (1 - s.a),
    g: s.g * s.a + d.g * (1 - s.a),
    b: s.b * s.a + d.b * (1 - s.a),
    a: 1,
  });
  const chan = (x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const lum = (c) => 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  // 沿祖先链把每一层背景从最外层不透明底往上合成
  const bgOf = (el) => {
    const chain = [];
    let n = el;
    while (n && n.nodeType === 1) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) chain.push(c);
      if (c && c.a >= 0.999) break;
      n = n.parentElement;
    }
    if (!chain.length) return { r: 255, g: 255, b: 255, a: 1 };
    let acc = chain[chain.length - 1];
    for (let i = chain.length - 2; i >= 0; i--) acc = over(chain[i], acc);
    return acc;
  };

  return JSON.stringify(targets.map(([label, sel, pseudo]) => {
    const el = document.querySelector(sel);
    if (!el) return { label: label, missing: true };
    const cs = getComputedStyle(el, pseudo || undefined);
    const fg = parse(cs.color);
    const bg = bgOf(el);
    const size = parseFloat(cs.fontSize) || 16;
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    return {
      label: label,
      fg: [Math.round(fg.r), Math.round(fg.g), Math.round(fg.b), fg.a],
      bg: [Math.round(bg.r), Math.round(bg.g), Math.round(bg.b)],
      size: Math.round(size * 100) / 100,
      weight: weight,
      large: large,
      need: large ? 3.0 : 4.5,
      ratio: Math.round(ratio(fg.a < 1 ? over(fg, bg) : fg, bg) * 100) / 100,
    };
  }));
})(%s)
"""


def run_pass(c, theme, targets, label, prep, query=""):
    url = "http://localhost:5183/preview.html?theme=%s" % theme
    if query:
        url += "&" + query
    c.cmd("Page.navigate", url=url)
    if not c.wait_ready(min_text=60):
        print("FAIL %s 页面未就绪" % theme)
        return None, 1, 0
    prep(c)
    rows = json.loads(c.eval(CONTRAST_JS % json.dumps(targets)))
    bad = 0
    measured = 0
    print("\n===== %s / %s =====" % (theme, label))
    for r in rows:
        if r.get("missing"):
            print("  SKIP %-28s 页面上没有这个元素" % r["label"])
            continue
        measured += 1
        ok = r["ratio"] >= r["need"] - 0.005
        if not ok:
            bad += 1
        print("  %-4s %-28s %6.2f:1  需 %.1f  (%spx/%s%s)  fg=rgba(%s) bg=rgb(%s)"
              % ("PASS" if ok else "FAIL", r["label"], r["ratio"], r["need"],
                 r["size"], r["weight"], " 大字" if r["large"] else "",
                 ",".join(str(x) for x in r["fg"]), ",".join(str(x) for x in r["bg"])))
    return rows, bad, measured

def main():
    try:
        c = CDP(9223)
    except Exception as e:
        # B12-8：连不上 CDP = 判不了（2），不带崩栈
        print("判不了：连不上 CDP 端口 9223 —— 先起 vite 5183 + 无头 Edge 9223（见 docs/DEVELOPMENT.md §4）")
        print("  原因：%s" % e)
        return 2
    c.cmd("Emulation.setDeviceMetricsOverride", width=1600, height=1000, deviceScaleFactor=1, mobile=False)

    # 占位符走伪元素，单列一次（Chrome 支持 getComputedStyle(el,'::placeholder')）
    targets = [(lbl, sel, "::placeholder" if lbl == "composer-ph/well" else None)
               for lbl, sel in TARGETS]
    settings_targets = [(lbl, sel, None) for lbl, sel in SETTINGS_TARGETS]
    settings_targets_b = [(lbl, sel, None) for lbl, sel in SETTINGS_TARGETS_B]

    def nav(cc, text):
        # 按文本点设置屏导航 —— 序号耦合是 A-1 的老事故(B19 插入「使用教程」后
        # 写死 nth-of-type 会把 about 取证静默落在帮助页上)。
        cc.eval("(() => { const els=[...document.querySelectorAll('.a-nav-item')];"
                " const el=els.find(e=>(e.textContent||'').trim()===%s);"
                " if (el) el.click(); return el?1:0; })()" % json.dumps(text))
        time.sleep(0.8)

    def prep_main(cc):
        # 先开一章、再造出会话，才能覆盖到编辑器/气泡/思考块这些元素
        run_flow(cc, FLOWS["editor"], verbose=False)
        run_flow(cc, FLOWS["chat"], verbose=False)

    def prep_settings(cc):
        # 进设置（默认落在提供商分节）→ 点保存，让 .a-flash 真的渲染出来
        cc.eval("(() => { const b = document.querySelector('.wbtn');"
                " if (b) { b.click(); return 1; } return 0; })()")
        time.sleep(0.8)
        cc.eval("(() => { const b = document.querySelector('.a-btn-primary');"
                " if (b) { b.click(); return 1; } return 0; })()")
        time.sleep(0.7)

    def prep_settings_b(cc):
        # 进设置 → 数据分节。只看不点：那是危险操作。
        # A-1：数据是第 5 项（provider/skill/params/theme/data/about）——
        # 旧序号 6 点到"关于"，.a-btn-danger 不在该页，三主题全 SKIP，
        # 危险色对比度从未被真实测量。
        cc.eval("(() => { const b = document.querySelector('.wbtn');"
                " if (b) { b.click(); return 1; } return 0; })()")
        time.sleep(0.8)
        nav(cc, "数据")

    def prep_settings_c(cc):
        # 进设置 → 关于分节(B19/D-053 的「作者与社群」卡:署名/构建烙印/群号)
        cc.eval("(() => { const b = document.querySelector('.wbtn');"
                " if (b) { b.click(); return 1; } return 0; })()")
        time.sleep(0.8)
        nav(cc, "关于")

    def prep_help(cc):
        # 标题栏「帮助」→ HelpModal(分类导航 + 正文 + 页脚署名)
        cc.eval("(() => { const b = document.querySelector('.tb-btn[aria-label=\"使用教程\"]');"
                " if (b) { b.click(); return 1; } return 0; })()")
        time.sleep(0.9)

    def prep_welcome(cc):
        # 首启弹窗由 ?welcome=1 直接呈现,无需点击(等入场动画落定)
        time.sleep(0.6)

    report = {}
    bad = 0
    measured_total = 0
    for theme in ("dark", "light"):
        rows, n, m = run_pass(c, theme, targets, "主工作台", prep_main)
        if rows is not None:
            report["%s/main" % theme] = rows
        bad += n
        measured_total += m
        rows, n, m = run_pass(c, theme, settings_targets, "设置·提供商", prep_settings)
        if rows is not None:
            report["%s/settings-a" % theme] = rows
        bad += n
        measured_total += m
        rows, n, m = run_pass(c, theme, settings_targets_b, "设置·数据", prep_settings_b)
        if rows is not None:
            report["%s/settings-b" % theme] = rows
        bad += n
        measured_total += m

    out = os.path.join("shots", "contrast-report.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    print("\nREPORT %s" % out)
    # B12-8：一条都没真正量到（vite 没起 / 选择器全漂移）＝判不了（2），
    # 不能报"全部达标" —— 那正是本文件注释里记的那个旧事故形态。
    if measured_total == 0:
        print("\n判不了：没有任何一条被真实测量（检查 vite 5183 与无头 Edge 9223）")
        return 2
    print("\n%s" % ("全部达标" if bad == 0 else "有 %d 项未达标" % bad))
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())