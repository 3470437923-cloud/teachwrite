"""Preview diagnostics: capture page exceptions / console output around an action.

Purpose : complements tools/preview_shot.py (which asserts geometry + takes
          screenshots) by answering "why did it break" -- it subscribes to
          Runtime.exceptionThrown / Runtime.consoleAPICalled / Log.entryAdded,
          performs optional clicks, and dumps what the page said, plus a DOM
          snapshot before/after.

Prereqs : vite dev server on 5183 serving the preview sandbox (preview.html +
          src/preview/mockBackend.ts), headless Edge with CDP on 9223 (launch
          command in docs/DEVELOPMENT.md), pip install websocket-client.

Usage:
  python tools/preview_diag.py                       # load preview, report console
  python tools/preview_diag.py --click ".wbtn"       # open settings via gear
  python tools/preview_diag.py --click ".wbtn" --theme light --html

Pitfalls: - Attaches to the FIRST "page" target on the CDP port; close other
            debuggable browsers or it may diagnose the wrong page.
          - Event domains are enabled before Page.navigate, so load-time
            exceptions are captured -- but anything thrown before this script
            connects (e.g. in another tab/session) is not.
          - Port 9223 / base 5183 are docs-level conventions; keep the
            defaults in sync if they ever change.
"""

import argparse
import json
import time
import urllib.request

import websocket


def find_page(port):
    data = json.loads(urllib.request.urlopen("http://127.0.0.1:%d/json" % port, timeout=5).read())
    pages = [t for t in data if t.get("type") == "page"]
    if not pages:
        raise SystemExit("no page target on port %d" % port)
    return pages[0]["webSocketDebuggerUrl"]


class Diag:
    def __init__(self, port):
        self.ws = websocket.create_connection(find_page(port), timeout=30, suppress_origin=True)
        self.mid = 0
        self.log = []

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
            self._record(msg)

    def _record(self, msg):
        method = msg.get("method")
        params = msg.get("params", {})
        if method == "Runtime.exceptionThrown":
            det = params.get("exceptionDetails", {})
            exc = det.get("exception", {}) or {}
            self.log.append({
                "kind": "exception",
                "text": det.get("text"),
                "desc": exc.get("description") or exc.get("value"),
                "url": det.get("url"),
                "line": det.get("lineNumber"),
                "col": det.get("columnNumber"),
                "stack": (det.get("stackTrace", {}) or {}).get("callFrames", [])[:6],
            })
        elif method == "Runtime.consoleAPICalled":
            self.log.append({
                "kind": "console:" + str(params.get("type")),
                "text": " ".join(str(a.get("value", a.get("description", ""))) for a in params.get("args", [])),
            })
        elif method == "Log.entryAdded":
            e = params.get("entry", {})
            self.log.append({"kind": "log:" + str(e.get("level")), "text": e.get("text")})

    def drain(self, seconds=1.5):
        self.ws.settimeout(seconds)
        try:
            while True:
                self._record(json.loads(self.ws.recv()))
        except Exception:
            pass
        finally:
            self.ws.settimeout(30)

    def eval(self, expr):
        r = self.cmd("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        if r.get("exceptionDetails"):
            return {"__exception": json.dumps(r["exceptionDetails"])[:500]}
        return r.get("result", {}).get("value")

    def snap(self):
        return self.eval(
            "(() => JSON.stringify({"
            " app: !!document.querySelector('.app-shell'),"
            " rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1,"
            " files: !!document.querySelector('.b-files'),"
            " emptyEditor: !!document.querySelector('.editor-empty'),"
            " nav: document.querySelectorAll('.a-nav-item').length,"
            " themecards: document.querySelectorAll('.a-themecard').length,"
            " textLen: (document.body.innerText||'').length,"
            " head: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,90)"
            "}))()"
        )

    def print_log(self):
        print("---- page log (%d entries) ----" % len(self.log))
        for entry in self.log:
            if entry["kind"] == "exception":
                print("[EXCEPTION] %s" % entry.get("text"))
                print("   desc: %s" % str(entry.get("desc"))[:1200])
                print("   at %s:%s:%s" % (entry.get("url"), entry.get("line"), entry.get("col")))
                for fr in entry.get("stack") or []:
                    print("   in %s (%s:%s)" % (fr.get("functionName"), fr.get("url"), fr.get("lineNumber")))
            else:
                print("[%s] %s" % (entry["kind"], str(entry["text"])[:1200]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9223)
    ap.add_argument("--base", default="http://localhost:5183")
    ap.add_argument("--theme", default="dark")
    ap.add_argument("--click", default="")
    ap.add_argument("--html", action="store_true", help="dump first 600 chars of body HTML after the action")
    ap.add_argument("--click2", default="", help="second selector to click after --click")
    ap.add_argument("--eval", default="", help="extra JS expression to evaluate last (printed verbatim)")
    ap.add_argument("--settle", type=float, default=1.6, help="seconds to wait after a click")
    args = ap.parse_args()

    d = Diag(args.port)
    d.cmd("Page.enable")
    d.cmd("Runtime.enable")
    d.cmd("Log.enable")
    d.cmd("Emulation.setDeviceMetricsOverride", width=1600, height=1000,
          deviceScaleFactor=1, mobile=False)
    d.cmd("Page.navigate", url="%s/preview.html?theme=%s" % (args.base, args.theme))

    deadline = time.time() + 25
    ready = False
    while time.time() < deadline:
        time.sleep(0.3)
        # N-36：eval() 在页面抛异常/导航中会返回 {"__exception": ...} 字典，
        # 它是真值 —— 旧判断把它当 READY，异常页被报成"就绪"。只认布尔 True。
        if d.eval("!!document.querySelector('.app-shell')") is True:
            ready = True
            break
    d.drain(1.0)
    print("READY %s" % ready)
    print("BEFORE %s" % d.snap())
    if not ready:
        # 页面 25 秒都没起来：诊断报告已输出（console/exception 段在后面），
        # 但退出码必须说明这不是一次正常诊断
        print("(page never became ready; see page log below)")
        d.print_log()
        return 1

    if args.click:
        print("CLICK %s -> %s" % (args.click, d.eval(
            "(() => { const el=document.querySelector(%s); if(!el) return 'MISSING';"
            " el.click(); return 'CLICKED'; })()" % json.dumps(args.click))))
        time.sleep(args.settle)
        d.drain(1.5)
        print("AFTER  %s" % d.snap())
        if args.html:
            html = d.eval("document.body.innerHTML.slice(0,600)")
            print("HTML   %s" % html)

    if args.click2:
        print("CLICK2 %s -> %s" % (args.click2, d.eval(
            "(() => { const el=document.querySelector(%s); if(!el) return 'MISSING';"
            " el.click(); return 'CLICKED'; })()" % json.dumps(args.click2))))
        time.sleep(args.settle)
        d.drain(1.5)
        print("AFTER2 %s" % d.snap())

    if args.eval:
        print("EVAL %s" % d.eval(args.eval))

    d.print_log()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())