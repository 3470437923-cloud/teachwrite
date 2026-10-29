"""Capture DocTable screenshots (before/after visual evidence) via CDP.

Usage:
  python tools/table_shot.py --theme dark --out shots/preview
"""
import argparse, base64, json, os, time, urllib.request
import websocket


def find_page(port):
    data = json.loads(urllib.request.urlopen("http://127.0.0.1:%d/json" % port, timeout=5).read())
    return [t for t in data if t.get("type") == "page"][0]["webSocketDebuggerUrl"]


class P:
    def __init__(self, port):
        self.ws = websocket.create_connection(find_page(port), timeout=60, suppress_origin=True)
        self.mid = 0

    def cmd(self, method, **params):
        self.mid += 1
        mid = self.mid
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == mid:
                if "error" in m:
                    raise RuntimeError(m["error"])
                return m.get("result", {})

    def js(self, expr):
        r = self.cmd("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        if r.get("exceptionDetails"):
            raise RuntimeError(json.dumps(r["exceptionDetails"])[:400])
        return r.get("result", {}).get("value")

    def shot(self, path):
        r = self.cmd("Page.captureScreenshot", format="png")
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "wb") as f:
            f.write(base64.b64decode(r["data"]))
        return path


CLICK = r"""
window.__t = {
  clickText: (txt) => {
    const b = Array.prototype.slice.call(document.querySelectorAll('.tnode'))
      .find((x) => ((x.querySelector('.lbl') || x).textContent || '').trim() === txt);
    if (!b) return false;
    b.click(); return true;
  },
  toTable: () => {
    const b = Array.prototype.slice.call(document.querySelectorAll('button.chip'))
      .filter((x) => /^表格$/.test((x.textContent || '').trim()))[0];
    if (b) { b.click(); return true; }
    return false;
  },
};
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9223)
    ap.add_argument("--base", default="http://localhost:5183")
    ap.add_argument("--theme", default="dark")
    ap.add_argument("--out", default="shots/preview")
    args = ap.parse_args()

    p = P(args.port)
    p.cmd("Page.enable")
    p.cmd("Runtime.enable")
    p.cmd("Emulation.setDeviceMetricsOverride", width=1600, height=1000, deviceScaleFactor=1, mobile=False)
    p.cmd("Page.navigate", url="%s/preview.html?promo=1&theme=%s" % (args.base, args.theme))
    time.sleep(3.5)
    p.js(CLICK)

    for label, name in [("规则台账.md", "ledger"), ("追踪-伏笔.md", "foreshadow"), ("03-全书大纲.md", "outline"), ("人物库.md", "cast"), ("06-写作风格.md", "style")]:
        p.js("window.__t.clickText(%s)" % json.dumps(label))
        time.sleep(1.0)
        p.js("window.__t.toTable()")
        time.sleep(0.8)
        path = os.path.join(args.out, "table-%s-%s.png" % (name, args.theme))
        p.shot(path)
        print("saved", path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
