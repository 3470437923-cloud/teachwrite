"""Temporary: hover/click the new usage entry button and screenshot the panel."""
import base64
import json
import time
import urllib.request
import websocket


def target(port=9223):
    data = json.loads(urllib.request.urlopen("http://127.0.0.1:%d/json" % port, timeout=5).read())
    return [t for t in data if t.get("type") == "page"][0]["webSocketDebuggerUrl"]


ws = websocket.create_connection(target(), timeout=30, suppress_origin=True)
mid = 0


def call(method, **params):
    global mid
    mid += 1
    ws.send(json.dumps({"id": mid, "method": method, "params": params}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == mid:
            if "error" in m:
                raise RuntimeError(json.dumps(m["error"]))
            return m.get("result", {})


def ev(expr):
    r = call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
    if r.get("exceptionDetails"):
        raise RuntimeError(json.dumps(r["exceptionDetails"])[:300])
    return r.get("result", {}).get("value")


call("Page.enable")
call("Runtime.enable")
call("Emulation.setDeviceMetricsOverride", width=1600, height=1000, deviceScaleFactor=1, mobile=False)
call("Page.navigate", url="http://localhost:5183/preview.html?theme=dark")
time.sleep(4)

center = json.loads(ev(
    "(() => { const b = document.querySelector('.usage-entry'); if (!b) return 'null';"
    " const r = b.getBoundingClientRect();"
    " return JSON.stringify({x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)}); })()"
))
print("button center:", center)
call("Input.dispatchMouseEvent", type="mouseMoved", x=center["x"], y=center["y"])
time.sleep(0.7)
state = ev(
    "(() => { const p = document.querySelector('.usage-pop');"
    " if (!p) return 'NOT_OPEN'; const r = p.getBoundingClientRect();"
    " return JSON.stringify({open: true, left: Math.round(r.left), right: Math.round(r.right),"
    " top: Math.round(r.top), inside: r.left >= 0 && r.right <= innerWidth}); })()"
)
print("hover panel:", state)
shot = call("Page.captureScreenshot", format="png")
open("shots/usagebtn/hover-panel.png", "wb").write(base64.b64decode(shot["data"]))

# click pin, move away, confirm it stays
call("Input.dispatchMouseEvent", type="mousePressed", x=center["x"], y=center["y"], button="left", clickCount=1)
call("Input.dispatchMouseEvent", type="mouseReleased", x=center["x"], y=center["y"], button="left", clickCount=1)
call("Input.dispatchMouseEvent", type="mouseMoved", x=400, y=500)
time.sleep(0.9)
state2 = ev(
    "(() => { const p = document.querySelector('.usage-pop');"
    " return p ? 'STILL_OPEN' : 'CLOSED'; })()"
)
print("pinned after moving away:", state2)
shot = call("Page.captureScreenshot", format="png")
open("shots/usagebtn/pinned-panel.png", "wb").write(base64.b64decode(shot["data"]))
