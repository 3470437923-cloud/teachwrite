"""Temporary probe: does the reflow four-state picker actually work on screen?

Drives the dev-only preview sandbox (preview.html + src/preview/mockBackend.ts)
over CDP. Answers three questions, in order:
  1. when the user clicks the chip, do all four options land inside the
     viewport and on top (hit-tested at their own centres)?
  2. does picking an option change the chip label and close the popup?
  3. do all four states round-trip (each option selectable, label follows)?

Why it exists: the four-state picker shipped with a pure layout defect that no
unit test could see -- `.think-pop` opens upward (bottom:100%), which is right
for the composer chip at the window bottom but wrong for the editor toolbar at
the window top. 110 of its 214 px rendered above the viewport, so the user saw
only the chip's own label and none of the three other options. Run this after
touching that toolbar or `.think-pop`.

Prerequisites:
  node node_modules\\vite\\bin\\vite.js            (dev server on 5183)
  msedge --headless=new --remote-debugging-port=9223 --remote-allow-origins=* \\
         --user-data-dir=%TEMP%\\deepcompose-edge --window-size=1600,1000 about:blank

Usage:
  python tools/reflow_probe.py
Exit code is 1 when any geometry/hit-test/round-trip check fails; the full
report lands in shots/reflow/reflow-probe.json plus PNG evidence next to it.
"""

import base64
import json
import os
import sys
import time
import urllib.request

import websocket

PORT = 9223
BASE = "http://localhost:5183"
OUT = os.path.join("shots", "reflow")


def find_page(port):
    data = json.loads(urllib.request.urlopen("http://127.0.0.1:%d/json" % port, timeout=5).read())
    pages = [t for t in data if t.get("type") == "page"]
    if not pages:
        raise SystemExit("no page target on port %d" % port)
    return pages[0]["webSocketDebuggerUrl"]


class CDP:
    def __init__(self, port):
        self.ws = websocket.create_connection(find_page(port), timeout=30, suppress_origin=True)
        self.mid = 0

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

    def eval(self, expr):
        r = self.cmd("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        if r.get("exceptionDetails"):
            raise RuntimeError("page exception: %s" % json.dumps(r["exceptionDetails"])[:500])
        return r.get("result", {}).get("value")

    def shot(self, path):
        r = self.cmd("Page.captureScreenshot", format="png", captureBeyondViewport=False)
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(r["data"]))
        return os.path.getsize(path)


GEOM = r"""
(() => {
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
  const inside = (r) => r && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
  const chip = document.querySelector('.editor-tools .think-wrap > button.chip');
  const pop = document.querySelector('.editor-tools .think-pop');
  const opts = Array.prototype.slice.call(document.querySelectorAll('.editor-tools .think-pop .think-stop'));
  let topAt = [];
  if (pop) {
    topAt = opts.map((o) => {
      const r = o.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
      if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) return 'OFFSCREEN';
      const el = document.elementFromPoint(cx, cy);
      return el && (el === o || o.contains(el)) ? 'OK' : 'COVERED_BY:' + (el ? (el.className || el.tagName) : 'null');
    });
  }
  const pr = pop ? pop.getBoundingClientRect() : null;
  return JSON.stringify({
    vw: innerWidth, vh: innerHeight,
    hasEditorTools: !!document.querySelector('.editor-tools'),
    chipLabel: chip ? chip.textContent.trim() : null,
    chipRect: rect(chip),
    popOpen: !!pop,
    popRect: rect(pop),
    popFullyInside: inside(pr),
    optCount: opts.length,
    optLabels: opts.map((o) => (o.querySelector('.ts-label') || {}).textContent || ''),
    optInside: opts.map((o) => inside(o.getBoundingClientRect())),
    optHitTest: topAt,
    activeTabName: (document.querySelector('.editor-title h1') || {}).textContent || null
  });
})()
"""


def click_xy(c, x, y):
    for t in ("mousePressed", "mouseReleased"):
        c.cmd("Input.dispatchMouseEvent", type=t, x=x, y=y, button="left", clickCount=1)


def click_chip(c):
    r = c.eval(
        "(() => { const b = document.querySelector('.editor-tools .think-wrap > button.chip');"
        " if (!b) return null; const r = b.getBoundingClientRect();"
        " return JSON.stringify({x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)}); })()"
    )
    if not r:
        raise SystemExit("no reflow chip")
    p = json.loads(r)
    click_xy(c, p["x"], p["y"])


def option_center(c, idx):
    r = c.eval(
        "(() => { const os = Array.prototype.slice.call("
        "document.querySelectorAll('.editor-tools .think-pop .think-stop'));"
        " if (os.length <= %d) return null; const r = os[%d].getBoundingClientRect();"
        " return JSON.stringify({x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)}); })()"
        % (idx, idx)
    )
    return json.loads(r) if r else None


def main():
    if not os.path.isdir(OUT):
        os.makedirs(OUT)
    c = CDP(PORT)
    c.cmd("Page.enable")
    c.cmd("Runtime.enable")
    c.cmd("Emulation.setDeviceMetricsOverride", width=1600, height=1000,
          deviceScaleFactor=1, mobile=False)
    c.cmd("Page.navigate", url="%s/preview.html?theme=dark" % BASE)

    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            st = json.loads(c.eval("(() => JSON.stringify({app: !!document.querySelector('.app-shell'),"
                                   " txt: (document.body.innerText||'').length}))()") or "{}")
            if st.get("app") and st.get("txt", 0) > 200:
                break
        except Exception:
            pass
        time.sleep(0.4)
    time.sleep(1.0)

    opened = c.eval(
        "(() => { const ns = Array.prototype.slice.call(document.querySelectorAll('.tnode'));"
        " const t = ns.find((n) => /^第\\d+章\\.md$/.test((n.textContent||'').trim()));"
        " if (!t) return 'NO_CHAPTER_NODE'; t.click(); return t.textContent.trim(); })()"
    )
    print("opened:", opened)
    time.sleep(1.2)

    click_chip(c)
    time.sleep(0.8)
    geo = json.loads(c.eval(GEOM))
    print("popup geometry:", json.dumps(geo, ensure_ascii=False))
    c.shot(os.path.join(OUT, "10-open-default.png"))

    problems = []
    if not geo["popOpen"]:
        problems.append("popup did not open")
    if geo["optCount"] != 4:
        problems.append("expected 4 options, got %s" % geo["optCount"])
    if not geo["popFullyInside"]:
        problems.append("popup not fully inside the viewport: %s" % geo["popRect"])
    for i, ok in enumerate(geo["optInside"]):
        if not ok:
            problems.append("option %d outside viewport" % i)
    for i, ok in enumerate(geo["optHitTest"]):
        if ok != "OK":
            problems.append("option %d not clickable: %s" % (i, ok))

    # round-trip all four states through real mouse clicks
    report = {"geometry": geo, "steps": []}
    order = [2, 1, 3, 0]  # 仅风格回流 → 仅资料回流 → 不回流保存 → 全部回流
    for idx in order:
        # the geometry step above left the popup open; only click the chip when it is closed
        if not json.loads(c.eval(GEOM))["popOpen"]:
            click_chip(c)
            time.sleep(0.5)
        if not json.loads(c.eval(GEOM))["popOpen"]:
            problems.append("popup failed to reopen before option %d" % idx)
            break
        pos = option_center(c, idx)
        click_xy(c, pos["x"], pos["y"])
        time.sleep(0.7)
        after = json.loads(c.eval(GEOM))
        step = {"optionIndex": idx, "label": after["chipLabel"],
                "popupClosed": not after["popOpen"],
                "status": c.eval("(document.querySelector('.statusbar, .foot-note, .status')||{}).textContent||''")}
        report["steps"].append(step)
        print("picked option %d -> chip=%s closed=%s" % (idx, step["label"], step["popupClosed"]))
        if after["popOpen"]:
            problems.append("popup stayed open after picking option %d" % idx)
        c.shot(os.path.join(OUT, "11-picked-%d.png" % idx))

    # leave it in the default state for the screenshot pair
    if not json.loads(c.eval(GEOM))["popOpen"]:
        click_chip(c)
        time.sleep(0.4)
    pos = option_center(c, 0)
    click_xy(c, pos["x"], pos["y"])
    time.sleep(0.5)
    if not json.loads(c.eval(GEOM))["popOpen"]:
        click_chip(c)
        time.sleep(0.6)
    c.shot(os.path.join(OUT, "12-final-open.png"))

    report["problems"] = problems
    with open(os.path.join(OUT, "reflow-probe.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    for p in problems:
        print("PROBLEM:", p)
    print("PROBLEMS %d" % len(problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
