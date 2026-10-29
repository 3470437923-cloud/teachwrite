"""无障碍降级断言 + 扁平度审计。

截图只能证明"看起来没坏"，证明不了 prefers-* 分支被命中，也证明不了
"整屏没有玻璃和渐变"。这里直接读计算样式做断言。

前提：vite dev server（5183）+ 无头 Edge CDP（9223）已启动（口径见
docs/DEVELOPMENT.md），页面为 preview.html + src/preview/mockBackend.ts；
复用 _shot_flow.py 的 CDP/FLOWS/run_flow（改那边签名会波及本脚本）。

用法：
    python tools/_a11y_check.py    # 全部通过退出码 0；有未通过 1；判不了（环境无法建立
                                   # 默认媒体态等）2 —— 与 _style_audit/_css_coverage 同口径

三件容易自欺的事，本脚本都绕开了：
  1. matchMedia 必须在设置仿真"之后"再读，否则读到的是上一状态。
  2. 断言要针对该块真正改动的属性。只探测 :root 令牌、而那个块改的是
     .panel 的 box-shadow，会得到"没变化"的假阴性。因此对比类断言
     一律拿"基准值 vs 降级值"来比，而不是对降级值凭空设一个期望。
  3. 元素要真的在 DOM 里。气泡要有会话，.cw-tip 只在欢迎空态 ——
     两者不可能同屏，所以探针按所需状态分组，各测一轮。

说明：这里不仿真 prefers-reduced-transparency —— 新体系默认状态就是实色、
无模糊、无光斑，该降级分支在 CSS 里已整体删除、无对象可测；对应的保障由
下面那段**扁平度审计**承担，它检验的正是"旧分支要处理的问题在新体系里
是否根本不存在"。
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _shot_flow import CDP, FLOWS, run_flow  # noqa: E402

# (说明, 选择器, 伪元素, 计算属性, 断言(now, base), 需要的前置状态)
#   前置状态：empty = 欢迎空态（不点任何东西）｜chat = 有会话｜streaming = 正在生成
# 旧实现把前置状态写成布尔（"要不要切会话"），然后**无论哪一组都跑一遍 stream 流程**：
#   · 空态探针要看的 .cw-tip 被自己发出去的那条消息顶掉；
#   · 生成态探针要看的 .streaming 被流程里 1.2s 的等待耗掉（生成是瞬时状态）。
# 结果是 12 条探针恒 __missing__、被报成产品缺陷 —— 探针先把自己的被测对象弄没了。
P = [
    ("进场动画关闭", ".win", None, "animationName", lambda v, b: v == "none", "chat"),
    ("欢迎提示不动", ".cw-tip", None, "animationName", lambda v, b: v == "none", "empty"),
    ("消息不动", ".msg", None, "animationName", lambda v, b: v == "none", "chat"),
    ("打字点不动", ".typing i", None, "animationName", lambda v, b: v == "none", "streaming"),
    # 生成中的行进线在降级态换成"整宽静止实线"：动效没了，状态还在。
    ("生成行进线静止", ".panel-chat.streaming", "::before", "animationName",
     lambda v, b: v == "none", "streaming"),
    ("行进线转整宽静止", ".panel-chat.streaming", "::before", "width",
     lambda v, b: float(v.rstrip("px")) > float(b.rstrip("px")), "streaming"),
    ("过渡压到极短", ".btn", None, "transitionDuration",
     lambda v, b: all(float(x.strip().rstrip("s") or 0) <= 0.05 for x in v.split(",")), "chat"),
]

PROBES = {
    "prefers-reduced-motion:reduce": P,
    "prefers-contrast:more": [
        ("面板描边加深", ".surface-sheet", None, "borderTopColor",
         lambda v, b: v != b, "chat"),
        ("气泡加描边", ".bubble", None, "boxShadow", lambda v, b: "inset" in v, "chat"),
        ("按钮加描边", ".btn", None, "boxShadow", lambda v, b: "inset" in v, "chat"),
        ("发丝线令牌加深", ".statusbar", None, "borderTopColor",
         lambda v, b: v != b, "chat"),
    ],
}

# 显式默认媒体态（**不能靠 features=[] 求默认**）：无头 Chromium/Edge 的
# `prefers-reduced-motion` 默认就是 reduce，于是"基准态"其实是被压过的降级态 ——
# 过渡存活检查因此把 0.01ms 读成产品缺陷（15 条假红）。所有基准测量一律显式声明。
DEFAULT_FEATURES = [
    {"name": "prefers-reduced-motion", "value": "no-preference"},
    {"name": "prefers-contrast", "value": "no-preference"},
]
STATE_LABEL = {"empty": "欢迎空态", "chat": "有会话", "streaming": "生成中"}

JS = """
(([sel, pseudo, prop]) => {
  const el = document.querySelector(sel);
  if (!el) return '__missing__';
  return String(getComputedStyle(el, pseudo || undefined)[prop]);
})(%s)
"""

# 发送按钮（生成态的准备动作；不放进 _shot_flow 的 FLOWS，因为那份流程带 1.2s 等待，
# 会把瞬时的 .streaming 状态等到消失）
JS_SEND = """
(() => {
  const el = document.querySelector('.send');
  if (!el) return 'miss';
  el.click();
  return 'ok';
})()
"""

# ── 扁平度审计 ──
# 目标态是"零玻璃、零渐变、零模糊"。逐元素扫（含 ::before/::after ——
# 旧体系里最漂亮的那处 conic 流光正好挂在伪元素上，只扫元素会漏掉）。
FLAT_JS = """
(() => {
  const label = (el) => {
    const cls = (el.className && String(el.className).trim().split(/\\s+/).slice(0, 3).join('.')) || '';
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
  };
  const blur = [], grad = [], filt = [];
  const nodes = Array.from(document.querySelectorAll('*'));
  for (const el of nodes) {
    for (const pseudo of [null, '::before', '::after']) {
      const s = getComputedStyle(el, pseudo || undefined);
      const where = label(el) + (pseudo || '');
      const bf = s.backdropFilter || s.webkitBackdropFilter;
      if (bf && bf !== 'none') blur.push(where + ' -> ' + bf);
      if (/gradient/.test(s.backgroundImage || '')) grad.push(where + ' -> ' + s.backgroundImage.slice(0, 90));
      if (/blur\\(/.test(s.filter || '')) filt.push(where + ' -> ' + s.filter);
    }
  }
  return JSON.stringify({
    blur: blur.slice(0, 12), grad: grad.slice(0, 12), filt: filt.slice(0, 12),
    counts: { blur: blur.length, grad: grad.length, filt: filt.length, elements: nodes.length },
  });
})()
"""


def pair(p):
    return json.dumps([p[1], p[2], p[3]])


def set_media(c, features):
    c.cmd("Emulation.setEmulatedMedia", features=features)


def reduced_motion_active(c):
    """当前页面上 (prefers-reduced-motion: reduce) 是否命中。"""
    return c.eval("matchMedia('(prefers-reduced-motion: reduce)').matches")


def open_streaming(c, timeout=4.0):
    """点发送后**轮询**等生成态出现（生成是瞬时状态，固定 sleep 必然错过）。

    返回 True 表示测量时刻页面上确实在生成。"""
    run_flow(c, FLOWS["composer"], verbose=False)  # 聚焦 + 灌文本（不发）
    c.eval(JS_SEND)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if c.eval("!!document.querySelector('.panel-chat.streaming')") is True:
            return True
        time.sleep(0.05)
    return False


def load(c, url, state):
    """按探针要求的前置状态准备页面。

    empty     = 欢迎空态：**不点任何东西**（.cw-tip 只在没有消息时存在）
    chat      = 有会话：切到预置会话（才有 .msg/.bubble）
    streaming = 生成中：发一条并轮询等 .streaming 出现
    """
    c.cmd("Page.navigate", url=url)
    if not c.wait_ready(min_text=60):
        return False
    if state == "empty":
        return True
    run_flow(c, FLOWS["chat"], verbose=False)
    if state == "streaming":
        return open_streaming(c)
    return True


def media_checks(c, base_url, theme):
    """按主题逐套验。必须逐主题跑：两套主题的令牌定义在选择器
    `:root` 与 `html[data-theme="..."]` 上，特异性不同 —— 曾经就有
    一个 @media (prefers-contrast) 块只写 `:root`，于是对 light
    完全失效、只在默认主题上碰巧命中。只在默认主题上验会漏掉它。"""
    url = "%s?theme=%s" % (base_url, theme)
    bad = 0
    for feature, probes in PROBES.items():
        name, _, value = feature.partition(":")
        for state in ("empty", "chat", "streaming"):
            group = [p for p in probes if p[5] == state]
            if not group:
                continue
            print("\n===== %s / %s  [%s] =====" % (theme, feature, STATE_LABEL.get(state, state)))

            set_media(c, DEFAULT_FEATURES)
            if not load(c, url, state):
                print("  FAIL 基准页面未就绪（状态：%s）" % STATE_LABEL.get(state, state))
                bad += 1
                continue
            base = {p[0]: c.eval(JS % pair(p)) for p in group}

            c.cmd("Emulation.setEmulatedMedia", features=[{"name": name, "value": value}])
            if not load(c, url, state):
                print("  FAIL 降级页面未就绪（状态：%s）" % STATE_LABEL.get(state, state))
                bad += 1
                continue
            hits = c.eval("matchMedia(%s).matches" % json.dumps("(%s: %s)" % (name, value)))
            print("  降级态媒体查询命中: %s" % hits)
            if not hits:
                bad += 1

            for p in group:
                label, now = p[0], c.eval(JS % pair(p))
                passed = now != "__missing__" and p[4](now, base.get(label) or "")
                if not passed:
                    bad += 1
                print("  %-4s %-14s %-40s -> %s"
                      % ("PASS" if passed else "FAIL", label, (base.get(label) or "")[:40], now[:40]))
    set_media(c, DEFAULT_FEATURES)
    return bad


def flat_checks(c, base_url):
    """扁平度审计：默认状态下整屏应当零模糊、零渐变、零 filter:blur()。

    必须**逐视图**扫，不能只扫主工作台。曾经漏过一次：设置屏的强调色色板
    用内联 `linear-gradient` 画了一块渐变，而主工作台视图里看不到它，
    只扫主视图的审计给不出任何异常。
    """
    print("\n===== 扁平度审计（默认状态，含伪元素）=====")
    views = [
        # (视图名, 进入该视图的点击序列)
        # A-1：导航序号必须与 SettingsScreen 的 navItems 一一对应 ——
        # 顺序是 provider/skill/params/theme/data/help/about（7 项，B19 起）。旧脚本按
        # 6 项年代写死 nth-of-type：B19 插入「使用教程」后 about 变第 7 项，
        # 于是所有 about 取证静默落在帮助页上（A-1 同型事故第二次）。
        # 更早一次是同型事故：按 7 项年代的序号点 6 项的页，两轮审计全程测错视图。
        # 现在导航一律用 __nav__:<文本>（按文本点，序号不耦合），并把帮助弹层 /
        # 使用教程分页 / 首启弹窗纳入（B19 的署名与帮助样式此前无人量过）。
        ("主工作台", []),
        ("设置·提供商", [".wbtn"]),
        ("设置·主题", [".wbtn", "__nav__:主题"]),
        ("设置·参数", [".wbtn", "__nav__:参数"]),
        ("设置·数据", [".wbtn", "__nav__:数据"]),
        ("设置·使用教程", [".wbtn", "__nav__:使用教程"]),
        ("设置·关于", [".wbtn", "__nav__:关于"]),
        ("备忘录", ['.tb-btn[title="备忘录"]']),
        ("帮助弹层", ['.tb-btn[aria-label="使用教程"]']),
        ("首启弹窗", []),
    ]
    bad = 0
    set_media(c, DEFAULT_FEATURES)
    for theme in ("dark", "light"):
        for view, clicks in views:
            u = "%s?theme=%s" % (base_url, theme)
            if view == "首启弹窗":
                u += "&welcome=1"
            c.cmd("Page.navigate", url=u)
            if not c.wait_ready(min_text=60):
                print("  FAIL %s/%s 未就绪" % (theme, view))
                bad += 1
                continue
            for sel in clicks:
                if sel.startswith("__nav__:"):
                    want = json.dumps(sel[len("__nav__:"):])
                    c.eval("(() => { const els=[...document.querySelectorAll('.a-nav-item')];"
                           " const el=els.find(e=>(e.textContent||'').trim()===%s);"
                           " if (el) el.click(); return el?1:0; })()" % want)
                else:
                    c.eval("(() => { const el=document.querySelector(%s);"
                           " if (el) el.click(); return 1; })()" % json.dumps(sel))
                time.sleep(0.7)
            raw = c.eval(FLAT_JS)
            try:
                r = json.loads(raw) if isinstance(raw, str) else raw
            except Exception:
                print("  FAIL %s/%s 审计脚本未返回可解析结果: %s" % (theme, view, str(raw)[:120]))
                bad += 1
                continue
            n = r["counts"]
            ok = n["blur"] == 0 and n["grad"] == 0 and n["filt"] == 0
            print("  %-4s %-7s %-14s 元素=%d backdrop-filter=%d 渐变=%d filter:blur=%d"
                  % ("PASS" if ok else "FAIL", theme, view, n["elements"], n["blur"], n["grad"], n["filt"]))
            if not ok:
                bad += 1
                for key in ("blur", "grad", "filt"):
                    for item in r[key][:6]:
                        print("        %s: %s" % (key, item))
    return bad


# 过渡存活检查：一个未定义的自定义属性会让整条 transition 简写在计算值
# 阶段失效，于是该元素**完全没有过渡** —— 页面上看不出来，截图看不出
# 来，但它把全站的悬停/按压反馈一次性拿掉了。这个探针专门盯这一类：
# 引用了消失令牌的元素，其 transitionDuration 会塌成 0s。
# 探针必须选**真正携带 transition 的那个元素**。曾经把 .composer-input 列进来
# 并判成失败 —— 其实它按设计就没有过渡，过渡挂在父级 .composer 的 box-shadow
# 上（聚焦时整块输入区亮一圈强调色）。选错元素会把"探针写错"报成"代码有缺陷"，
# 和漏报一样糟。
ALIVE = [
    ("按钮有过渡", ".btn"),
    ("树节点有过渡", ".tnode"),
    ("页签有过渡", ".tab"),
    ("输入区聚焦有过渡", ".composer"),
    ("胶囊有过渡", ".chip"),
]


def alive_checks(c, base_url):
    """返回未通过数；**返回 None 表示环境无法建立默认媒体态**（本次测量作废，退出码 2）。

    为什么必须显式声明默认态：无头 Chromium/Edge 的 prefers-reduced-motion 默认是
    reduce，而 CSS 在 reduce 下把过渡压到 0.01ms —— 不声明默认态就会把"降级分支
    生效"读成"产品没有过渡"，整段审计变成假红。
    """
    print("\n===== 过渡存活（多套主题，显式默认媒体态）=====")
    bad = 0
    checked = 0
    set_media(c, DEFAULT_FEATURES)
    for theme in ("dark", "light"):
        c.cmd("Page.navigate", url="%s?theme=%s" % (base_url, theme))
        if not c.wait_ready(min_text=60):
            print("  FAIL %s 未就绪" % theme)
            bad += 1
            continue
        if reduced_motion_active(c):
            print("  TOOL-ERROR %s：无法建立默认媒体态 —— (prefers-reduced-motion: reduce) 仍命中；"
                  "此时读到的过渡时长是被压过的降级值，不能当产品结论" % theme)
            return None
        run_flow(c, FLOWS["editor"], verbose=False)
        for label, sel in ALIVE:
            v = c.eval(JS % json.dumps([sel, None, "transitionDuration"]))
            if v == "__missing__":
                print("  SKIP %-7s %-14s 页面上没有这个元素" % (theme, label))
                continue
            checked += 1
            vals = [float(x.strip().rstrip("s") or 0) for x in v.split(",")]
            ok = max(vals) > 0.02
            if not ok:
                bad += 1
            print("  %-4s %-7s %-14s %s" % ("PASS" if ok else "FAIL", theme, label, v))
    # B12-8：五个探针一个都没找到元素（选择器漂移/页面没渲染）＝判不了（2），
    # 不能因为 bad==0 就报"全部通过" —— 那是把"判不了"当通过。
    if checked == 0:
        print("  TOOL-ERROR：过渡探针一个都没落到元素上（选择器漂移或页面未渲染）")
        return -1
    return bad


def main():
    try:
        c = CDP(9223)
    except Exception as e:
        # B12-8：连不上 CDP = 判不了（2），不带崩栈
        print("判不了：连不上 CDP 端口 9223 —— 先起 vite 5183 + 无头 Edge 9223（见 docs/DEVELOPMENT.md §4）")
        print("  原因：%s" % e)
        return 2
    url = "http://localhost:5183/preview.html"
    c.cmd("Emulation.setDeviceMetricsOverride", width=1600, height=1000,
          deviceScaleFactor=1, mobile=False)

    bad = 0
    for theme in ("dark", "light"):
        bad += media_checks(c, url, theme)
    bad += flat_checks(c, url)
    alive = alive_checks(c, url)
    if alive is None or alive < 0:
        print("\n判不了：环境无法建立默认媒体态，或过渡探针一个都没落到元素上（退出码 2）")
        return 2
    bad += alive
    print("\n%s" % ("全部通过" if bad == 0 else "有 %d 项未通过" % bad))
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())