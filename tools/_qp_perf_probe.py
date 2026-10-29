"""Perf probe: drive the real 'write next chapter' quick-prompt flow in promo mode
and measure main-thread cost: long tasks, per-frame jank, JS heap growth.

Root-cause hypothesis under test: every streamed token sets state on MainWorkbench,
which re-renders the WHOLE workbench (file tree for all docs + every past message +
isToolErrorResult()/JSON.parse on every tool result). On a long quick-prompt flow
(many tool rounds + big results) this saturates the renderer: UI locks up,
memory climbs -> user sees it as a crash.

Prereq: vite 5183 + headless Edge CDP 9223. Prints numbers only; exit 0 always
(this is a measurement, not a gate).
"""
import json, sys, time, urllib.request
import websocket

def page_ws(port=9223):
    d = json.loads(urllib.request.urlopen("http://127.0.0.1:%d/json" % port, timeout=5).read())
    return [t for t in d if t.get("type") == "page"][0]["webSocketDebuggerUrl"]

class P:
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

p = P()
p.cmd("Page.enable"); p.cmd("Runtime.enable")
p.cmd("Emulation.setDeviceMetricsOverride", width=1600, height=1000, deviceScaleFactor=1, mobile=False)
p.cmd("Page.navigate", url="http://localhost:5183/preview.html?theme=dark&promo=1")
dl = time.time() + 35
while time.time() < dl:
    time.sleep(0.3)
    if p.ev("!!document.querySelector('.app-shell')") is True:
        break

# instrumentation: long tasks + frame gaps + heap
p.ev("""(() => {
  window.__m = { long: [], gaps: [], nodes: [], heap: [] };
  new PerformanceObserver(l => { for (const e of l.getEntries()) window.__m.long.push(+e.duration.toFixed(0)); }).observe({entryTypes:['longtask']});
  let last = performance.now();
  const raf = (t) => { window.__m.gaps.push(+(t-last).toFixed(1)); last = t; requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  const tick = () => { const m = performance.memory; if (m) window.__m.heap.push(Math.round(m.usedJSHeapSize/1048576));
                       window.__m.nodes.push(document.querySelectorAll('*').length);
                       setTimeout(tick, 400); };
  tick();
  return 'armed';
})()""")

print("open book:", p.ev("(() => {const b=document.querySelector('.bk'); b && b.click(); return 'ok'})()"))
p.ev("(() => {const t=document.querySelector('.qp-toggle'); t&&t.click(); return 'open'})()")
time.sleep(0.4)
# 写下一章 (index 0) — the longest real flow
print("pick:", p.ev("(() => {const e=document.querySelectorAll('.qp-pop .qp-pick')[0]; if(!e) return 'MISSING'; e.click(); return 'ok'})()"))
time.sleep(0.3)
print("send:", p.ev("(() => {const e=document.querySelector('.send'); if(!e) return 'MISSING'; e.click(); return 'ok'})()"))

# let it run: answer question modals as they appear, until flow ends or 90s
t0 = time.time()
answered = 0
while time.time() - t0 < 90:
    time.sleep(2.0)
    st = p.ev("JSON.stringify({q:!!document.querySelector('.qmodal'),msgs:document.querySelectorAll('.msg').length,tools:document.querySelectorAll('.tool-line').length,busy:!!document.querySelector('.chip.stop')})")
    s = json.loads(st) if isinstance(st, str) else {}
    if s.get("q"):
        p.ev("(() => {const o=document.querySelector('.qopt'); o&&o.click(); const b=document.querySelector('.qsubmit'); b&&b.click(); return 1})()")
        answered += 1
    if not s.get("busy") and time.time() - t0 > 8:
        break
    if time.time() - t0 > 12 and s.get("q"):
        p.ev("(() => {const o=document.querySelector('.qopt'); o&&o.click(); const b=document.querySelector('.qsubmit'); b&&b.click(); return 1})()")
        answered += 1

m = p.ev("JSON.stringify({long:window.__m.long, worstGap:Math.max.apply(null,window.__m.gaps.slice(1)), gapCount50:window.__m.gaps.filter(g=>g>50).length, frames:window.__m.gaps.length, heapFirst:window.__m.heap[0], heapLast:window.__m.heap[window.__m.heap.length-1], heapMax:Math.max.apply(null,window.__m.heap), nodesFirst:window.__m.nodes[0], nodesLast:window.__m.nodes[window.__m.nodes.length-1]})")
print("\n==== 主线程实测 ====")
print(m)
print("answered questions:", answered)
sys.exit(0)
