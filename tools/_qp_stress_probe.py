"""Quick-prompt flow stress probe (preview sandbox, promo mode).

Grows the chat history with N scripted sends (promo SSE replays tool rows + thinking),
then during the NEXT send measures per-token render cost: long tasks, frame gaps,
DOM nodes, heap. Same sequence run before/after the memoization fix gives the A/B.

Prereq: vite 5183 + headless Edge CDP 9223. Exit 0 always (measurement).
"""
import json, sys, time, urllib.request
import websocket

def page_ws(port=9223):
    d = json.loads(urllib.request.urlopen("http://127.0.0.1:%d/json" % port, timeout=5).read())
    pages = [t for t in d if t.get("type") == "page"]
    return pages[0]["webSocketDebuggerUrl"]

class C:
    def __init__(self):
        self.ws = websocket.create_connection(page_ws(), timeout=90, suppress_origin=True)
        self.mid = 0
    def cmd(self, m, **p):
        self.mid += 1
        self.ws.send(json.dumps({"id": self.mid, "method": m, "params": p}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.mid:
                return msg.get("result", {})
    def ev(self, expr):
        r = self.cmd("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        if r.get("exceptionDetails"):
            return {"__exc": json.dumps(r["exceptionDetails"])[:200]}
        return r.get("result", {}).get("value")

c = C()
c.cmd("Page.enable"); c.cmd("Runtime.enable")
c.cmd("Emulation.setDeviceMetricsOverride", width=1600, height=1000, deviceScaleFactor=1, mobile=False)
c.cmd("Page.navigate", url="http://localhost:5183/preview.html?theme=dark&promo=1")
dl = time.time() + 35
while time.time() < dl:
    time.sleep(0.3)
    if c.ev("!!document.querySelector('.app-shell')") is True:
        break
print("ready")

ARM = """(() => {
  window.__m = { long: [], gaps: [], measuring: false };
  new PerformanceObserver(l => { if (window.__m.measuring) for (const e of l.getEntries()) window.__m.long.push(Math.round(e.duration)); }).observe({entryTypes:['longtask']});
  let last = performance.now();
  const raf = (t) => { if (window.__m.measuring) window.__m.gaps.push(+(t - last).toFixed(1)); last = t; requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  return 'armed';
})()"""
c.ev(ARM)
c.ev("(() => {const b=document.querySelector('.bk'); b && b.click(); return 1})()")
time.sleep(0.4)

# grow history: 5 sends of the same quick prompt (promo replays 5 tool rows + thinking each)
for i in range(5):
    c.ev("(() => {const e=document.querySelector('.qp-toggle'); if(!document.querySelector('.qp-pop')) e&&e.click(); return 1})()")
    time.sleep(0.25)
    c.ev("(() => {const e=document.querySelectorAll('.qp-pop .qp-pick')[0]; e&&e.click(); return 1})()")
    time.sleep(0.25)
    c.ev("(() => {const e=document.querySelector('.send'); if(e&&!e.disabled) e.click(); return 1})()")
    time.sleep(6.0)
    st = c.ev("JSON.stringify({msgs:document.querySelectorAll('.msg').length,tools:document.querySelectorAll('.tool-line').length,q:!!document.querySelector('.qmodal')})")
    if isinstance(st, str) and json.loads(st).get("q"):
        c.ev("(() => {const o=document.querySelector('.qopt'); o&&o.click(); const b=document.querySelector('.qsubmit'); b&&b.click(); return 1})()")
        time.sleep(3.0)
print("history:", c.ev("JSON.stringify({msgs:document.querySelectorAll('.msg').length,tools:document.querySelectorAll('.tool-line').length,thinkChars:[...document.querySelectorAll('.think')].reduce((a,e)=>a+e.textContent.length,0),nodes:document.querySelectorAll('*').length,heapMB:(performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):-1)})"))

# measure the NEXT send
c.ev("window.__m.measuring = true; window.__m.long.length=0; window.__m.gaps.length=0; 1")
c.ev("(() => {const e=document.querySelector('.qp-toggle'); if(!document.querySelector('.qp-pop')) e&&e.click(); return 1})()")
time.sleep(0.2)
c.ev("(() => {const e=document.querySelectorAll('.qp-pop .qp-pick')[0]; e&&e.click(); return 1})()")
time.sleep(0.2)
c.ev("(() => {const e=document.querySelector('.send'); if(e&&!e.disabled) e.click(); return 1})()")
time.sleep(8.0)
c.ev("window.__m.measuring = false; 1")
m = c.ev("JSON.stringify({longTasks:window.__m.long, worstGap:Math.max(0,...window.__m.gaps.slice(1)), gapsOver33:window.__m.gaps.filter(g=>g>33).length, frames:window.__m.gaps.length})")
print("MEASURED:", m)
print("(longTasks=主线程被占满的帧; worstGap>100ms 即肉眼卡顿)")
sys.exit(0)
