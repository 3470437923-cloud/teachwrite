"""Quick-prompt crash probe: drive the preview sandbox through the exact user path
(click a quick prompt chip -> send -> stream -> tool rows -> question modal) and
dump every page exception. Same CDP conventions as _shot_flow.py.

Prereq: vite dev on 5183 + headless Edge CDP on 9223 (docs/DEVELOPMENT.md sec.4).
Exit: 0 clean / 1 exceptions seen / 2 could not run.
"""
import json, sys, time, urllib.request
import websocket

def page_ws(port=9223):
    data = json.loads(urllib.request.urlopen("http://127.0.0.1:%d/json" % port, timeout=5).read())
    pages = [t for t in data if t.get("type") == "page"]
    if not pages:
        raise SystemExit("no page target")
    return pages[0]["webSocketDebuggerUrl"]

class P:
    def __init__(self):
        self.ws = websocket.create_connection(page_ws(), timeout=40, suppress_origin=True)
        self.mid = 0
        self.exc = []
        self.console = []
    def cmd(self, m, **p):
        self.mid += 1
        self.ws.send(json.dumps({"id": self.mid, "method": m, "params": p}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.mid:
                if "error" in msg:
                    raise RuntimeError("%s -> %s" % (m, json.dumps(msg["error"])[:300]))
                return msg.get("result", {})
            self._rec(msg)
    def _rec(self, msg):
        if msg.get("method") == "Runtime.exceptionThrown":
            d = msg["params"].get("exceptionDetails", {})
            e = d.get("exception", {}) or {}
            self.exc.append({
                "text": d.get("text"), "desc": (e.get("description") or e.get("value")),
                "url": d.get("url"), "line": d.get("lineNumber"), "col": d.get("columnNumber"),
                "stack": [(f.get("functionName"), f.get("url"), f.get("lineNumber")) for f in (d.get("stackTrace") or {}).get("callFrames", [])[:8]],
            })
        elif msg.get("method") == "Runtime.consoleAPICalled":
            t = msg["params"].get("type")
            if t in ("error", "warning"):
                self.console.append(t + " " + " ".join(str(a.get("value", a.get("description", ""))) for a in msg["params"].get("args", []))[:400])
    def drain(self, s):
        self.ws.settimeout(s)
        try:
            while True:
                self._rec(json.loads(self.ws.recv()))
        except Exception:
            pass
        finally:
            self.ws.settimeout(40)
    def ev(self, expr):
        r = self.cmd("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        if r.get("exceptionDetails"):
            return {"__exc": json.dumps(r["exceptionDetails"])[:400]}
        return r.get("result", {}).get("value")
    def click(self, sel):
        return self.ev("(() => {const el=document.querySelector(%s); if(!el) return 'MISSING'; el.click(); return 'CLICKED';})()" % json.dumps(sel))
    def clickNth(self, sel, n):
        return self.ev("(() => {const el=document.querySelectorAll(%s)[%d]; if(!el) return 'MISSING'; el.click(); return 'CLICKED:'+el.textContent.trim().slice(0,20);})()" % (json.dumps(sel), n))

BASE = "http://localhost:5183/preview.html?theme=dark"
p = P()
p.cmd("Page.enable"); p.cmd("Runtime.enable")
p.cmd("Emulation.setDeviceMetricsOverride", width=1600, height=1000, deviceScaleFactor=1, mobile=False)
p.cmd("Page.navigate", url=BASE)
deadline = time.time() + 30
ready = False
while time.time() < deadline:
    time.sleep(0.3)
    if p.ev("!!document.querySelector('.app-shell')") is True:
        ready = True; break
p.drain(1.0)
print("READY", ready)
if not ready:
    print("PAGE NEVER READY"); [print(e) for e in p.exc]; sys.exit(2)

def state(tag):
    s = p.ev("(() => JSON.stringify({"
             " bar: document.querySelectorAll('.qp-bar .chip').length,"
             " pop: !!document.querySelector('.qp-pop'),"
             " composer: (document.querySelector('.composer-input')||{}).value ? (document.querySelector('.composer-input').value.length) : -1,"
             " msgs: document.querySelectorAll('.msg').length,"
             " tools: document.querySelectorAll('.tool-line').length,"
             " qmodal: !!document.querySelector('.qmodal'),"
             " appAlive: !!document.querySelector('.app-shell'),"
             " rootKids: (document.getElementById('root')||{}).childElementCount"
             "}))()")
    print("%-14s %s" % (tag, s))
    return s

state("boot")
print("toggle ->", p.click(".qp-toggle")); p.drain(0.6); state("after-open")
rows = p.ev("document.querySelectorAll('.qp-pop .qp-pick').length")
print("pop rows:", rows)
# 1) pick the 2nd prompt from the expanded list
print("pick#1 ->", p.clickNth(".qp-pop .qp-pick", 1)); p.drain(0.8); state("after-pick")
# 2) send it
print("send#1 ->", p.click(".send")); 
for _ in range(9):
    p.drain(1.0)
    s = state("streaming")
    if isinstance(s, str) and json.loads(s)["msgs"] >= 2 and not json.loads(s).get("appAlive"):
        break
time.sleep(1.0); p.drain(0.5); state("after-send1")
# 3) click peek chips repeatedly (rapid double-click path)
print("peek#0 ->", p.clickNth(".qp-bar .chip", 0))
print("peek#1 ->", p.clickNth(".qp-bar .chip", 1))
print("peek#0b ->", p.clickNth(".qp-bar .chip", 0))
p.drain(0.8); state("after-peek")
# 4) open manage + edit + save
print("toggle2 ->", p.click(".qp-toggle")); p.drain(0.5)
print("edit ->", p.clickNth(".qp-pop .qp-rowact", 0)); p.drain(0.5)
print("form:", p.ev("!!document.querySelector('.qp-form')"))
print("save ->", p.click(".qp-form .btn-accent")); p.drain(0.8); state("after-edit")
# 5) delete a row while pop open
print("del ->", p.clickNth(".qp-pop .qp-rowact", 1)); p.drain(0.8)
print("rows now:", p.ev("document.querySelectorAll('.qp-pop .qp-pick').length"))
# 6) new prompt then cancel
print("toggle3 ->", p.click(".qp-toggle") if not p.ev("!!document.querySelector('.qp-pop')") else "open")
p.drain(0.4)
print("add ->", p.click(".qp-add")); p.drain(0.4)
print("cancel ->", p.click(".qp-form .btn-quiet")); p.drain(0.4)
# 7) send again after deletions (composer may hold long prompt)
print("send#2 ->", p.click(".send")); time.sleep(3.0); p.drain(1.5); state("after-send2")
# 8) Esc while pop open
print("toggle4 ->", p.click(".qp-toggle")); p.drain(0.4)
p.cmd("Input.dispatchKeyEvent", type="keyDown", key="Escape", code="Escape", windowsVirtualKeyCode=27)
p.cmd("Input.dispatchKeyEvent", type="keyUp", key="Escape", code="Escape", windowsVirtualKeyCode=27)
p.drain(0.6); state("after-esc")
# 9) reload to verify persistence round-trip did not corrupt the file
p.cmd("Page.navigate", url=BASE)
deadline = time.time() + 30
while time.time() < deadline:
    time.sleep(0.3)
    if p.ev("!!document.querySelector('.app-shell')") is True: break
p.drain(1.0)
state("after-reload")
print("peek after reload:", p.ev("[...document.querySelectorAll('.qp-bar .chip')].map(c=>c.textContent.trim()).join('|')"))

print("\n---- EXCEPTIONS (%d) ----" % len(p.exc))
for e in p.exc:
    print(json.dumps(e, ensure_ascii=False, indent=1))
print("---- console err/warn (%d) ----" % len(p.console))
for c in p.console[:20]:
    print(c)
sys.exit(1 if p.exc else 0)
