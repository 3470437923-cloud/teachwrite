"""运行时样式审计：找出「匹配不到任何 CSS 规则」的元素。

用途：静态类名校验只能查"某个类有没有被定义过"，查不到作用域选择器的漏写
（例如 `.memo-card .d` 缺失时，`d` 这个类名在别处定义过，静态检查就放过了）。
本审计在真实 DOM 上做：对每个元素用 el.matches() 遍历全部规则，一个都匹配
不上的元素就是"裸奔元素" —— 它没有任何样式落点，是最容易漏掉的组件部位。

前提：vite dev server（5183）+ 无头 Edge CDP（9223）已启动（口径见
docs/DEVELOPMENT.md）；复用 _shot_flow.py 的 CDP/FLOWS/run_flow。

用法：
    python tools/_style_audit.py --flows none,chat,memo,theme,params

已知坑：
    - el.matches() 对每个元素遍历全部规则，复杂度 O(元素 × 规则)，大 DOM
      下偏慢属正常，别当卡死处理。
    - AUDIT_JS 剥伪类的正则只覆盖常见状态伪类与 nth-*/not/is/where；冷门
      函数伪类可能让个别选择器进 try/catch 被忽略，造成极少量漏检。
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _shot_flow import CDP, FLOWS, run_flow  # noqa: E402

AUDIT_JS = r"""
(() => {
  const sels = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { continue; }
    const walk = (list) => {
      for (const r of list) {
        if (r.selectorText) sels.push(r.selectorText);
        else if (r.cssRules) walk(r.cssRules);
      }
    };
    walk(rules);
  }
  // 把所有选择器拆成单个（逗号分隔），去掉伪元素/伪类以便 matches 用
  const flat = [];
  for (const s of sels) {
    for (const part of s.split(",")) {
      let p = part.trim();
      if (!p) continue;
      // 去掉伪元素，并剥掉 :hover/:active/:focus 等状态伪类（裸元素判定只关心
      // "这个元素在本状态下有没有样式来源"，状态规则也算来源）
      p = p.replace(/::[a-zA-Z-]+(\([^)]*\))?/g, "");
      p = p.replace(/:(hover|active|focus|focus-visible|focus-within|disabled|placeholder)\b/g, "");
      p = p.replace(/:(nth-child|nth-of-type|not|is|where)\([^()]*(\([^()]*\))?[^()]*\)/g, "");
      p = p.replace(/^\s*[>+~]\s*/, "");
      if (!p || p === "*") continue;
      flat.push(p);
    }
  }
  const bare = [];
  const seen = new Set();
  // 没有类名但"必须有样式落点"的标签：漏写后代选择器时它们会以浏览器
  // 默认尺寸渲染（例如 <img> 按原始像素铺满整屏）。纯文本容器（div/span/p）
  // 没有样式是正常的，不报。
  const RISKY = new Set(["IMG", "INPUT", "TEXTAREA", "SELECT",
    "H1", "H2", "H3", "H4", "H5", "H6", "BUTTON", "A", "CANVAS", "SVG", "TABLE"]);
  for (const el of document.querySelectorAll("*")) {
    const classed = el.classList.length > 0;
    if (!classed && !RISKY.has(el.tagName)) continue;
    let hit = false;
    for (const s of flat) {
      try { if (el.matches(s)) { hit = true; break; } } catch (e) { /* 无效选择器忽略 */ }
    }
    if (!hit) {
      const key = el.tagName + (classed ? "." + [...el.classList].join(".") : " (无类名)");
      if (!seen.has(key)) { seen.add(key); bare.push(key); }
    }
  }
  return JSON.stringify({
    ruleCount: flat.length,
    checked: document.querySelectorAll("*").length,
    bare: bare,
  });
})()
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9223)
    ap.add_argument("--base", default="http://localhost:5183")
    ap.add_argument("--themes", default="dark,light")
    ap.add_argument("--flows", default="none,chat,memo,theme,params,about")
    ap.add_argument("--size", default="1600x1000")
    ap.add_argument("--min-text", type=int, default=60)
    args = ap.parse_args()

    w, h = (int(x) for x in args.size.lower().split("x"))
    themes = [t.strip() for t in args.themes.split(",") if t.strip()]
    flows = [f.strip() for f in args.flows.split(",") if f.strip()]

    # N-51：未知 flow 名旧实现直接 FLOWS[flow] KeyError 崩掉（栈 traceback
    # 而不是人话）。启动即校验并列出可用名。
    unknown = [f for f in flows if f not in FLOWS]
    if unknown:
        print("未知 flow 名: %s" % ", ".join(unknown))
        print("可用 flow 名: %s" % ", ".join(sorted(FLOWS)))
        return 2

    try:
        c = CDP(args.port)
    except Exception as e:
        # B12-8：连不上 CDP = 判不了（2），不是"有问题"（1）更不是崩栈 —— 三脚本同口径
        print("判不了：连不上 CDP 端口 %d —— 先起 vite 5183 + 无头 Edge 9223（见 docs/DEVELOPMENT.md §4）" % args.port)
        print("  原因：%s" % e)
        return 2
    all_bare = {}
    measured = 0
    for theme in themes:
        for flow in flows:
            c.cmd(
                "Emulation.setDeviceMetricsOverride",
                width=w, height=h, deviceScaleFactor=1, mobile=False,
            )
            c.cmd("Page.navigate", url="%s/preview.html?theme=%s" % (args.base, theme))
            if not c.wait_ready(min_text=args.min_text):
                print("FAIL %s/%s 未渲染" % (theme, flow))
                continue
            time.sleep(0.4)
            run_flow(c, FLOWS[flow], verbose=False)
            time.sleep(0.35)
            raw = c.eval(AUDIT_JS)
            if not raw:
                print("FAIL %s/%s 审计无输出" % (theme, flow))
                continue
            measured += 1
            d = json.loads(raw)
            for b in d["bare"]:
                all_bare.setdefault(b, []).append("%s/%s" % (theme, flow))
            print(
                "  %-8s %-8s 规则 %4d  元素 %4d  裸奔 %d"
                % (flow, theme, d["ruleCount"], d["checked"], len(d["bare"]))
            )

    print("\n==== 裸奔元素汇总（没有任何 CSS 规则命中）====")
    if not all_bare:
        print("  无 —— 所有带类元素都有样式落点")
    for sel, where in sorted(all_bare.items(), key=lambda kv: -len(kv[1])):
        locs = sorted(set(where))
        print("  %-46s 出现在: %s" % (sel, ", ".join(locs[:6]) + (" …" if len(locs) > 6 else "")))
    # E-3：与 _a11y_check/_contrast_audit 同口径 —— 有问题必须以非零退出，
    # 否则并列的"审计闸门"里它永远全绿
    # B12-8：**一次都没测到**（vite 没起 / CDP 连到空白页）时必须是 2（判不了），
    # 不能因为 all_bare 为空就报"全清" —— 那正是"判不了当通过"。
    if measured == 0:
        print("  判不了：没有任何一轮真正测到 DOM（检查 vite 5183 与无头 Edge 9223）")
        return 2
    return 1 if all_bare else 0


if __name__ == "__main__":
    sys.exit(main())