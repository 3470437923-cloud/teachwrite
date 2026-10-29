"""Cold-read floating panel end-to-end probe (D-045).

Drives the dev-only preview sandbox over CDP and verifies:
  1. 冷读 button opens a floating panel (no scrim, no session switch);
  2. plot channel runs, streams into the panel only, parses into grouped rows;
  3. row ops: delete is permanent, locate reports, send -> submitted -> removed on success;
  4. style channel runs with its own categories;
  5. closing the panel discards everything (reopen starts at setup again).

Usage: python tools/coldread_probe.py   (vite on 5183 + headless Edge on 9223)
Exit 1 on any failed check; PNG evidence in shots/coldread/.
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
OUT = os.path.join("shots", "coldread")

problems = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ("  " + detail if detail else ""))
    if not ok:
        problems.append(name)


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
            raise RuntimeError("page exception: %s" % json.dumps(r["exceptionDetails"])[:600])
        return r.get("result", {}).get("value")

    def shot(self, path):
        r = self.cmd("Page.captureScreenshot", format="png", captureBeyondViewport=False)
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(r["data"]))

    def click_text(self, scope, text):
        """Click the first button under `scope` whose trimmed text == text."""
        return self.eval(
            "(() => { const bs = Array.prototype.slice.call(document.querySelectorAll(%s + ' button'));"
            " const b = bs.find((x) => (x.textContent || '').trim() === %s);"
            " if (!b) return 'MISSING'; b.click(); return 'CLICKED'; })()"
            % (json.dumps(scope), json.dumps(text))
        )


def wait_for(c, expr, timeout=20.0, label=""):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if c.eval(expr):
            return True
        time.sleep(0.4)
    print("TIMEOUT waiting:", label or expr[:120])
    return False


PANEL = r"""
(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.prototype.slice.call(document.querySelectorAll(s));
  const panel = q('.cold-float');
  if (!panel) return JSON.stringify({ open: false });
  const rows = qa('.cf-row');
  const groups = qa('.cf-group-h').map((g) => g.textContent.trim());
  const scrim = !!q('.qmodal.scrim');
  const sessTitle = (q('.sess-title') || {}).textContent || '';
  return JSON.stringify({
    open: true,
    scrimBlocking: scrim,
    phase: q('.qsubmit') ? 'setup' : (q('.cf-stream') ? 'running' : 'done'),
    groups: groups,
    rowCount: rows.length,
    submitted: qa('.cf-row.submitted').length,
    sentTags: qa('.cf-sent').length,
    noIssues: !!q('.cf-clean'),
    leftover: !!q('.cf-leftover'),
    sessionTitle: sessTitle.trim(),
    streamLen: (q('.cf-stream') || {}).textContent ? q('.cf-stream').textContent.length : 0,
    chatStreamLen: (q('.chat-scroll') || {}).textContent ? q('.chat-scroll').textContent.length : 0
  });
})()
"""


def main():
    if not os.path.isdir(OUT):
        os.makedirs(OUT)
    c = CDP(PORT)
    c.cmd("Page.enable")
    c.cmd("Runtime.enable")
    c.cmd("Emulation.setDeviceMetricsOverride", width=1600, height=1000, deviceScaleFactor=1, mobile=False)
    c.cmd("Page.navigate", url="%s/preview.html?theme=dark" % BASE)

    if not wait_for(c, "!!document.querySelector('.app-shell') && (document.body.innerText||'').length > 200", label="app ready"):
        return 1
    time.sleep(1.0)

    # open 第3章 (has priors 1-2)
    opened = c.eval(
        "(() => { const ns = Array.prototype.slice.call(document.querySelectorAll('.tnode'));"
        " const t = ns.find((n) => (n.textContent||'').trim() === '第3章.md');"
        " if (!t) return 'MISSING'; t.click(); return 'OK'; })()"
    )
    check("open chapter tab", opened == "OK", opened)
    time.sleep(1.0)

    # 1) open the cold-read panel from the editor toolbar
    r = c.click_text(".editor-tools", "冷读")
    check("click 冷读 opens panel", r == "CLICKED", r)
    time.sleep(0.6)
    st = json.loads(c.eval(PANEL))
    check("panel open, setup phase, no scrim", st.get("open") and st.get("phase") == "setup" and not st.get("scrimBlocking"), json.dumps(st, ensure_ascii=False))
    c.shot(os.path.join(OUT, "01-setup-plot.png"))

    # drag: grab the header, move (+140, +50), assert the panel follows
    pos0 = json.loads(c.eval(
        "(() => { const p = document.querySelector('.cold-float'); const r = p.getBoundingClientRect();"
        " return JSON.stringify({x: Math.round(r.left), y: Math.round(r.top)}); })()"
    ))
    hx, hy = pos0["x"] + 120, pos0["y"] + 12
    c.cmd("Input.dispatchMouseEvent", type="mousePressed", x=hx, y=hy, button="left", clickCount=1)
    c.cmd("Input.dispatchMouseEvent", type="mouseMoved", x=hx + 140, y=hy + 50, button="left")
    c.cmd("Input.dispatchMouseEvent", type="mouseReleased", x=hx + 140, y=hy + 50, button="left", clickCount=1)
    time.sleep(0.4)
    pos1 = json.loads(c.eval(
        "(() => { const p = document.querySelector('.cold-float'); const r = p.getBoundingClientRect();"
        " return JSON.stringify({x: Math.round(r.left), y: Math.round(r.top)}); })()"
    ))
    check("panel draggable", abs(pos1["x"] - pos0["x"] - 140) < 4 and abs(pos1["y"] - pos0["y"] - 50) < 4, "%s -> %s" % (pos0, pos1))
    # drag it back so later screenshots are deterministic
    c.cmd("Input.dispatchMouseEvent", type="mousePressed", x=hx + 140, y=hy + 50, button="left", clickCount=1)
    c.cmd("Input.dispatchMouseEvent", type="mouseMoved", x=hx, y=hy, button="left")
    c.cmd("Input.dispatchMouseEvent", type="mouseReleased", x=hx, y=hy, button="left", clickCount=1)
    time.sleep(0.3)

    # 2) start plot cold read (default channel=plot, priors=上一章)
    r = c.click_text(".cold-float", "开始冷读")
    check("start plot run", r == "CLICKED", r)
    ok = wait_for(c, "document.querySelectorAll('.cf-row').length > 0", timeout=25, label="rows parsed")
    check("plot run produced rows", ok)
    st = json.loads(c.eval(PANEL))
    print("plot state:", json.dumps(st, ensure_ascii=False))
    check("3 rows in 3 groups", st.get("rowCount") == 3 and len(st.get("groups", [])) == 3, str(st.get("groups")))
    check("leftover block present", st.get("leftover") is True)
    check("chat session NOT switched to a cold session", "冷读" not in st.get("sessionTitle", ""), st.get("sessionTitle", ""))
    c.shot(os.path.join(OUT, "02-plot-rows.png"))

    # 3) locate: click 定位 on a row whose quote will not be in 第3章 → status bar should say so
    r = c.eval(
        "(() => { const b = Array.prototype.slice.call(document.querySelectorAll('.cf-act'))"
        ".find((x) => x.textContent.trim() === '定位'); if (!b) return 'MISSING'; b.click(); return 'CLICKED'; })()"
    )
    check("locate click", r == "CLICKED", r)
    time.sleep(0.5)
    status = c.eval("(document.querySelector('.statusbar, .app-status, footer')||document.body).innerText")
    print("status after locate:", (status or "")[-120:])

    # 4) delete row: check first row, click 删除选中
    c.eval("(() => { const cb = document.querySelector('.cf-row .cf-check'); cb.click(); })()")
    time.sleep(0.3)
    r = c.click_text(".cold-float", "删除选中")
    check("bulk delete clicked", r == "CLICKED", r)
    time.sleep(0.4)
    st = json.loads(c.eval(PANEL))
    check("row deleted permanently (3 -> 2)", st.get("rowCount") == 2, str(st.get("rowCount")))

    # 5) send remaining rows to AI: select all open rows, 修复选中
    c.eval("(() => { document.querySelectorAll('.cf-row .cf-check').forEach((cb) => { if (!cb.checked) cb.click(); }); })()")
    time.sleep(0.3)
    r = c.eval(
        "(() => { const b = Array.prototype.slice.call(document.querySelectorAll('.cf-bulk .btn'))"
        ".find((x) => x.textContent.trim().startsWith('修复选中')); if (!b) return 'MISSING'; b.click(); return 'CLICKED'; })()"
    )
    check("send selected to AI", r == "CLICKED", r)
    time.sleep(0.6)
    st = json.loads(c.eval(PANEL))
    check("rows marked submitted", st.get("submitted") == 2, json.dumps(st, ensure_ascii=False))
    c.shot(os.path.join(OUT, "03-submitted.png"))
    # the fix runs in the main chat; wait for it to finish (busy flag clears -> rows removed)
    ok = wait_for(c, "document.querySelectorAll('.cf-row').length === 0", timeout=60, label="fix done, rows removed")
    st = json.loads(c.eval(PANEL))
    check("rows removed after successful fix", ok and st.get("rowCount") == 0, "rows=%s" % st.get("rowCount"))
    c.shot(os.path.join(OUT, "04-after-fix.png"))

    # 6) style channel: close panel, reopen, switch to style, run
    r = c.click_text(".cold-float", "完成，关闭")
    if r != "CLICKED":
        r = c.eval("(() => { const b = Array.prototype.slice.call(document.querySelectorAll('.cf-x')).pop(); if(!b) return 'MISSING'; b.click(); return 'CLICKED'; })()")
    check("close panel", r == "CLICKED", r)
    time.sleep(0.5)
    check("panel discarded", json.loads(c.eval(PANEL)).get("open") is not True)

    r = c.click_text(".editor-tools", "冷读")
    check("reopen panel", r == "CLICKED", r)
    time.sleep(0.6)
    st = json.loads(c.eval(PANEL))
    check("reopen starts at setup (nothing retained)", st.get("phase") == "setup" and st.get("rowCount") == 0)
    r = c.click_text(".cold-float", "风格 · 对照档案")
    check("switch to style channel", r == "CLICKED", r)
    time.sleep(0.3)
    c.shot(os.path.join(OUT, "05-setup-style.png"))
    r = c.click_text(".cold-float", "开始冷读")
    check("start style run", r == "CLICKED", r)
    ok = wait_for(c, "document.querySelectorAll('.cf-row').length > 0", timeout=25, label="style rows parsed")
    st = json.loads(c.eval(PANEL))
    print("style state:", json.dumps(st, ensure_ascii=False))
    check("style run produced 2 rows in 2 groups", ok and st.get("rowCount") == 2 and len(st.get("groups", [])) == 2, str(st.get("groups")))
    c.shot(os.path.join(OUT, "06-style-rows.png"))

    print("PROBLEMS %d" % len(problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
