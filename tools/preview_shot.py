"""Preview screenshot + geometry probe (CDP, no Playwright required).

Purpose : drive the dev-only preview sandbox (preview.html +
          src/preview/mockBackend.ts) through the Chrome DevTools protocol,
          capture the three themes and assert layout geometry. Works while the
          screen is locked or the display sleeps, because capture goes through
          Page.captureScreenshot instead of the OS.

Prerequisites:
  npm run dev            (vite dev server on 5183)
  msedge --headless=new --remote-debugging-port=9223 --remote-allow-origins=* \
         --user-data-dir=%TEMP%\\deepcompose-edge --window-size=1600,1000 about:blank
  (the temp profile dir name is cosmetic; any fresh dedicated dir works - an
  already-running Edge owns the default profile and the debug port never opens)

Usage:
  python tools/preview_shot.py
  python tools/preview_shot.py --themes dark --sizes 1600x1000
  python tools/preview_shot.py --port 9223 --base http://localhost:5183

Pitfalls: - Attaches to the FIRST "page" target on the CDP port; close other
            debuggable browsers or it may probe the wrong page.
          - Geometry/session assertions depend on the mockBackend fixture data
            (session titles, chapter names); editing fixtures can flip checks
            without any real layout regression.
          - Exit code is 1 when any run fails; full detail lands in
            probe-report.json under --out (default shots/preview/).
"""

import argparse
import base64
import json
import os
import sys
import time
import urllib.request

import websocket  # pip install websocket-client

THEMES = ["dark", "light"]
SIZES = [(1600, 1000), (1280, 800), (1024, 700)]

# Runs in the page: returns a JSON string of everything we want asserted.
# A-7：旧探针整套在测玻璃时代的选择器（.glass/.grain/.ambient .orb/--bg-base），
# 实色体系重构后这些类全部不存在 —— 探测恒空、结果静默无效。现在改为
# 断言**当前体系的不变量**：零 backdrop-filter、零渐变、零 filter:blur()，
# 与 _a11y_check.py 的扁平度审计同口径（这里的样本是单帧几何，那边更全面）。
PROBE = r"""
(() => {
  const q = (s) => document.querySelector(s);
  const de = document.documentElement;
  const app = q('.app-shell');
  const r = app ? app.getBoundingClientRect() : null;
  const winEl = q('.win');
  const wr = winEl ? winEl.getBoundingClientRect() : null;
  const menu = q('.sess-menu');
  const mr2 = menu ? menu.getBoundingClientRect() : null;
  const sitems = Array.prototype.slice.call(document.querySelectorAll('.sess-item'));
  // 扁平度不变量：整屏（含伪元素）不允许玻璃/渐变/模糊
  let backdropBlur = 0, gradients = 0, filterBlur = 0;
  for (const el of document.querySelectorAll('*')) {
    for (const pseudo of [null, '::before', '::after']) {
      const s = getComputedStyle(el, pseudo || undefined);
      const bf = s.backdropFilter || s.webkitBackdropFilter;
      if (bf && bf !== 'none') backdropBlur++;
      if (/gradient/.test(s.backgroundImage || '')) gradients++;
      if (/blur\(/.test(s.filter || '')) filterBlur++;
    }
  }
  return JSON.stringify({
    theme: de.dataset.theme || null,
    hasAppShell: !!app,
    backdropBlur: backdropBlur,
    gradients: gradients,
    filterBlur: filterBlur,
    accent: getComputedStyle(de).getPropertyValue('--accent').trim(),
    docScrollW: de.scrollWidth, docClientW: de.clientWidth,
    docScrollH: de.scrollHeight, docClientH: de.clientHeight,
    overflowX: de.scrollWidth > de.clientWidth + 1,
    overflowY: de.scrollHeight > de.clientHeight + 1,
    appRect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
    winRect: wr ? { w: Math.round(wr.width), h: Math.round(wr.height) } : null,
    winClass: winEl ? winEl.className : null,
    menuRect: mr2 ? { t: Math.round(mr2.top), b: Math.round(mr2.bottom), h: Math.round(mr2.height) } : null,
    sessItemsTotal: sitems.length,
    sessItemsInsideMenu: mr2
      ? sitems.filter((e) => { const r = e.getBoundingClientRect();
          return r.top >= mr2.top - 1 && r.bottom <= mr2.bottom + 1; }).length
      : null,
    bottomGap: r ? Math.round(de.clientHeight - (r.y + r.height)) : null,
    titlebar: !!q('.titlebar'),
    sessionItems: document.querySelectorAll('.sess-item').length,
    themeCards: document.querySelectorAll('.a-themecard').length,
    navItems: document.querySelectorAll('.a-nav-item').length,
    textLen: (document.body.innerText || '').length,
    legacyWrap: !!q('.fitter') || !!q('.win-frame'),
    head: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 100)
  });
})()
"""


def find_page(port):
    data = json.loads(urllib.request.urlopen("http://127.0.0.1:%d/json" % port, timeout=5).read())
    pages = [t for t in data if t.get("type") == "page"]
    if not pages:
        raise SystemExit("no page target on port %d" % port)
    return pages[0]["webSocketDebuggerUrl"]


class CDP:
    def __init__(self, port):
        self.ws = websocket.create_connection(
            find_page(port), timeout=30, suppress_origin=True
        )
        self.mid = 0
        self.events = []

    def cmd(self, method, **params):
        self.mid += 1
        mid = self.mid
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError("%s -> %s" % (method, json.dumps(msg["error"])))
                return msg.get("result", {})
            if "method" in msg:
                self.events.append(msg["method"])

    def eval(self, expr):
        r = self.cmd("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        res = r.get("result", {})
        if r.get("exceptionDetails"):
            raise RuntimeError("page exception: %s" % json.dumps(r["exceptionDetails"])[:400])
        return res.get("value")

    def shot(self, path):
        r = self.cmd("Page.captureScreenshot", format="png", captureBeyondViewport=False)
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(r["data"]))
        return os.path.getsize(path)


def wait_ready(c, timeout=25.0, min_text=80):
    """Poll until the app shell mounted and the mock backend fed it data."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            state = c.eval(
                "(() => { const a=document.querySelector('.app-shell');"
                " const t=(document.body.innerText||'').length;"
                " return JSON.stringify({app:!!a, txt:t}); })()"
            )
            last = json.loads(state) if state else None
            if last and last.get("app") and last.get("txt", 0) >= min_text:
                time.sleep(0.6)  # let transitions / fonts settle
                return True, last
        except Exception as exc:  # page still navigating
            last = {"err": str(exc)[:120]}
        time.sleep(0.35)
    return False, last


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9223)
    ap.add_argument("--base", default="http://localhost:5183")
    ap.add_argument("--out", default=os.path.join("shots", "preview"))
    ap.add_argument("--themes", default=",".join(THEMES))
    ap.add_argument("--sizes", default=",".join("%dx%d" % s for s in SIZES))
    ap.add_argument("--shot-sizes", default="1600x1000",
                    help="which sizes also get a PNG (comma separated; 'all' = every size)")
    ap.add_argument("--view", default="main", choices=["main", "settings"],
                    help="settings = click the gear and probe the settings screen")
    ap.add_argument("--clicks", default="",
                    help="comma separated selector chain to click after load "
                         "(overrides --view); e.g. \".wbtn,.a-nav-item:nth-of-type(4)\"")
    ap.add_argument("--label", default="",
                    help="output filename label (default: the --view value)")
    ap.add_argument("--query", default="",
                    help="extra query params appended to the preview URL, e.g. \"fail=prefs\"")
    ap.add_argument("--min-text", type=int, default=80,
                    help="body text length that counts as 'rendered' (lower it for error pages)")
    args = ap.parse_args()

    if args.clicks:
        clicks = [s for s in args.clicks.split(",") if s.strip()]
    elif args.view == "settings":
        # A-6：按 title 精确点齿轮 —— "第一个 .wbtn" 依赖 DOM 顺序，进了
        # 设置屏后第一个 .wbtn 是「最小化」，跨屏复用会点错窗口按钮。
        clicks = ['button.wbtn[title="设置"]']
    else:
        clicks = []
    label = args.label or args.view

    themes = [t.strip() for t in args.themes.split(",") if t.strip()]
    sizes = []
    for s in args.sizes.split(","):
        w, h = s.strip().lower().split("x")
        sizes.append((int(w), int(h)))
    shot_sizes = sizes if args.shot_sizes == "all" else [
        tuple(int(v) for v in s.strip().lower().split("x"))
        for s in args.shot_sizes.split(",") if s.strip()
    ]

    outdir = args.out
    if not os.path.isdir(outdir):
        os.makedirs(outdir)

    c = CDP(args.port)
    c.cmd("Page.enable")
    c.cmd("Runtime.enable")

    report = {"base": args.base, "runs": [], "failures": []}
    for theme in themes:
        for (w, h) in sizes:
            c.cmd("Emulation.setDeviceMetricsOverride", width=w, height=h,
                  deviceScaleFactor=1, mobile=False)
            url = "%s/preview.html?theme=%s%s" % (
                args.base, theme, ("&" + args.query) if args.query else "")
            c.cmd("Page.navigate", url=url)
            ok, state = wait_ready(c, min_text=args.min_text)
            row = {"theme": theme, "size": "%dx%d" % (w, h), "ready": ok}
            if not ok:
                row["state"] = state
                report["failures"].append(row)
                report["runs"].append(row)
                print("FAIL %s %dx%d -> %s" % (theme, w, h, json.dumps(state)))
                continue
            for sel in clicks:
                res = c.eval(
                    "(() => { const el=document.querySelector(%s); if(!el) return 'MISSING';"
                    " el.click(); return 'CLICKED'; })()" % json.dumps(sel)
                )
                row.setdefault("clicks", []).append({"selector": sel, "result": res})
                deadline = time.time() + 12
                while time.time() < deadline:
                    if c.eval("!!document.querySelector('.a-nav, .a-nav-item, .editor-empty')"):
                        break
                    time.sleep(0.3)
                time.sleep(0.6)
            probe = json.loads(c.eval(PROBE))
            row["probe"] = probe
            # B12-8：探针结果必须**真的参与判定** —— 旧实现只把 probe 打印出来，
            # 文档承诺的"几何断言"从未生效（重新长出渐变/玻璃/横向溢出时退出码照样 0）。
            problems = []
            if not probe.get("hasAppShell"):
                problems.append("app-shell 缺失（页面没起来）")
            if probe.get("theme") != theme:
                problems.append("主题未生效：theme=%s（期望 %s）" % (probe.get("theme"), theme))
            if probe.get("backdropBlur"):
                problems.append("出现 backdrop-filter：%d 处" % probe["backdropBlur"])
            if probe.get("gradients"):
                problems.append("出现渐变：%d 处" % probe["gradients"])
            if probe.get("filterBlur"):
                problems.append("出现 filter:blur()：%d 处" % probe["filterBlur"])
            if probe.get("overflowX"):
                problems.append("横向溢出（scrollW %s > clientW %s）"
                                % (probe.get("docScrollW"), probe.get("docClientW")))
            if probe.get("overflowY"):
                problems.append("纵向溢出（scrollH %s > clientH %s）"
                                % (probe.get("docScrollH"), probe.get("docClientH")))
            if probe.get("legacyWrap"):
                problems.append("出现旧体系包裹层（.fitter/.win-frame）")
            if problems:
                row["problems"] = problems
                report["failures"].append(row)
            if (w, h) in shot_sizes:
                path = os.path.join(outdir, "%s-%s-%dx%d.png" % (label, theme, w, h))
                row["shot"] = path
                row["shotBytes"] = c.shot(path)
            report["runs"].append(row)
            print("%-7s %-9s %s  blur=%d grad=%d filt=%d ovX=%s ovY=%s gap=%s winH=%s accent=%s"
                  % (theme, "%dx%d" % (w, h), "FAIL" if problems else "-ok ", probe["backdropBlur"],
                     probe["gradients"], probe["filterBlur"], probe["overflowX"], probe["overflowY"],
                     probe["bottomGap"], (probe.get("winRect") or {}).get("h"), probe["accent"]))
            for p in problems:
                print("        ! %s" % p)

    with open(os.path.join(outdir, "probe-report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    print("REPORT %s" % os.path.join(outdir, "probe-report.json"))
    print("RUNS %d  FAILURES %d" % (len(report["runs"]), len(report["failures"])))
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())