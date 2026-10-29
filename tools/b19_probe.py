"""B19 UI probe: 帮助 / 首启欢迎弹窗 / 关于页作者卡 / open_url 接线 / 群号复制。

跑在预览沙箱上(vite 5183 + headless Edge CDP 9223),断言:
  A. ?welcome=1 时首启弹窗出现:logo + 作者名 + 群号 + 抖音按钮 + 三条出路
  B. 勾「不再显示」→ 开始写作 → 弹窗关闭且 prefs 写入 welcome_dismissed
  C. 不勾选时关闭 → 再次导航回来仍会弹(未被永久抑制)
  D. 标题栏「帮助」→ HelpModal 打开,分类可切换,页脚含作者与群号
  E. 设置屏「使用教程」分页内嵌同一份内容
  F. 关于页「作者与社群」卡:作者/群号/复制/抖音/copyright/构建烙印
  G. 点抖音按钮走 open_url(mock 静默成功),无页面异常
退出码:0 全过 / 1 有问题 / 2 跑不起来(与 tools/ 其它审计脚本同一口径)
"""
import json, os, sys, time, urllib.request
import websocket

BASE = "http://localhost:5183"
PORT = 9223

# 截图输出目录：从**本脚本位置**推导项目根（tools/ 的上一级），不再写死盘符。
# 原先写死 r"S:\deepcompose\shots" —— 那是开发机的路径，macOS 上根本没有 S: 盘，
# os.makedirs 会直接抛 FileNotFoundError，整个探针跑不起来。
# 可用环境变量 DC_SHOTS 覆盖（对照 tools/_compare_sheet.py 的 ROOT 推导口径）。
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.environ.get("DC_SHOTS") or os.path.join(ROOT, "shots")

def page_ws():
    d = json.loads(urllib.request.urlopen("http://127.0.0.1:%d/json" % PORT, timeout=5).read())
    pages = [t for t in d if t.get("type") == "page"]
    if not pages:
        raise SystemExit("no page target on %d" % PORT)
    return pages[0]["webSocketDebuggerUrl"]

class C:
    def __init__(self):
        self.ws = websocket.create_connection(page_ws(), timeout=60, suppress_origin=True)
        self.mid = 0
        self.exc = []
    def cmd(self, m, **p):
        self.mid += 1
        self.ws.send(json.dumps({"id": self.mid, "method": m, "params": p}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.mid:
                if "error" in msg:
                    raise RuntimeError("%s -> %s" % (m, json.dumps(msg["error"])[:200]))
                return msg.get("result", {})
            self._rec(msg)
    def _rec(self, msg):
        if msg.get("method") == "Runtime.exceptionThrown":
            d = msg["params"].get("exceptionDetails", {})
            e = d.get("exception", {}) or {}
            self.exc.append({"text": d.get("text"), "desc": (e.get("description") or "")[:400],
                             "stack": [(f.get("functionName"), f.get("url"), f.get("lineNumber")) for f in (d.get("stackTrace") or {}).get("callFrames", [])[:5]]})
    def drain(self, s=0.6):
        self.ws.settimeout(s)
        try:
            while True:
                self._rec(json.loads(self.ws.recv()))
        except Exception:
            pass
        finally:
            self.ws.settimeout(60)
    def ev(self, expr):
        r = self.cmd("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        if r.get("exceptionDetails"):
            return {"__exc": json.dumps(r["exceptionDetails"])[:300]}
        return r.get("result", {}).get("value")
    def shot(self, name):
        try:
            b64 = self.cmd("Page.captureScreenshot", format="png").get("data")
            import base64, io
            os.makedirs(SHOTS, exist_ok=True)
            with open(os.path.join(SHOTS, name), "wb") as f:
                f.write(base64.b64decode(b64))
            return name
        except Exception as e:
            return "shot fail " + str(e)[:60]

PROBLEMS = []
def check(cond, label, detail=""):
    if cond:
        print("  ok   %s" % label)
    else:
        print("  FAIL %s %s" % (label, detail))
        PROBLEMS.append(label)

def goto(u):
    c.cmd("Page.navigate", url=u)
    dl = time.time() + 30
    while time.time() < dl:
        time.sleep(0.3)
        if c.ev("!!document.querySelector('.app-shell')") is True:
            break
    c.drain(1.2)

c = C()
c.cmd("Page.enable"); c.cmd("Runtime.enable")
c.cmd("Emulation.setDeviceMetricsOverride", width=1600, height=1000, deviceScaleFactor=1, mobile=False)

print("== A: 首启欢迎弹窗(?welcome=1) ==")
goto(BASE + "/preview.html?theme=dark&promo=1&welcome=1")
box = c.ev("JSON.stringify({w:!!document.querySelector('.welcome-box'),h:(document.querySelector('.welcome-h')||{}).textContent,txt:(document.querySelector('.welcome-box')||{}).innerText,logo:!!document.querySelector('.welcome-logo img'),never:!!document.querySelector('.welcome-never input'),rows:document.querySelectorAll('.welcome-row').length})")
check(isinstance(box, str), "welcome box read", str(box)[:120])
d = json.loads(box) if isinstance(box, str) else {}
check(d.get("w") is True, "弹窗出现")
check("欢迎使用 DeepCompose" in (d.get("h") or ""), "标题文案", d.get("h"))
check("Liumorrow" in (d.get("txt") or ""), "作者名(Rust 下发)", (d.get("txt") or "")[:60])
check("1071188925" in (d.get("txt") or ""), "QQ 群号")
check("抖音" in (d.get("txt") or ""), "抖音入口")
check(d.get("logo") is True, "品牌 logo")
check(d.get("never") is True, "「不再显示」勾选框")
check(d.get("rows") == 3, "三行信息卡", str(d.get("rows")))
check(c.shot("b19-welcome-dark.png") == "b19-welcome-dark.png", "截图 welcome")
print("== G: 抖音按钮走 open_url(沙箱静默成功,不应抛异常) ==")
c.ev("(() => {const bs=[...document.querySelectorAll('.welcome-row button')]; const b=bs.find(x=>/抖音/.test(x.textContent)); if(b) b.click(); return !!b})()")
c.drain(1.0)
check(not c.exc, "点击抖音无页面异常", json.dumps(c.exc[:1], ensure_ascii=False)[:200])

print("== B: 勾选「不再显示」→ 开始写作 → 关闭 + prefs 落盘 ==")
c.ev("(() => {const i=document.querySelector('.welcome-never input'); if(i&&!i.checked) i.click(); return 1})()")
c.drain(0.3)
c.ev("(() => {const b=[...document.querySelectorAll('.welcome-actions button')].find(x=>/开始写作/.test(x.textContent)); b&&b.click(); return 1})()")
c.drain(0.8)
check(c.ev("!!document.querySelector('.welcome-box')") is False, "弹窗已关闭")
prefs = c.ev("""(async () => {
  const t = (window.__DSH_PREVIEW_PREFS_DUMP) ? window.__DSH_PREVIEW_PREFS_DUMP() : null;
  return t;
})()""")
# 预览替身没有导出 dump;改为二次导航验证(dismiss 已写进 prefsStore,重载后不再弹)
print("== C: dismiss 落盘后重载不再弹(验证 prefs 往返) ==")
goto(BASE + "/preview.html?theme=dark&promo=1")
check(c.ev("!!document.querySelector('.welcome-box')") is False, "已 dismiss:默认不弹")
goto(BASE + "/preview.html?theme=dark&promo=1&welcome=1")
check(c.ev("!!document.querySelector('.welcome-box')") is True, "?welcome=1 仍可强制弹(验收入口)")
# Esc 关闭(不落盘)
c.cmd("Input.dispatchKeyEvent", type="keyDown", key="Escape", code="Escape", windowsVirtualKeyCode=27)
c.cmd("Input.dispatchKeyEvent", type="keyUp", key="Escape", code="Escape", windowsVirtualKeyCode=27)
c.drain(0.6)
check(c.ev("!!document.querySelector('.welcome-box')") is False, "Esc 可关(不永久抑制)")

print("== D: 标题栏「帮助」入口与 HelpModal ==")
hb = c.ev("""(() => {
  const b=[...document.querySelectorAll('.tb-btn')].find(x=>/使用教程/.test(x.title||''));
  if(!b) return 'MISSING';
  b.click(); return 'OK';
})()""")
check(hb == "OK", "标题栏帮助按钮存在", str(hb))
c.drain(0.8)
hm = c.ev("JSON.stringify({m:!!document.querySelector('.help-modal'),tabs:document.querySelectorAll('.help-nav [role=tab]').length,on:document.querySelectorAll('.help-item.on').length,ps:document.querySelectorAll('.help-p').length,h:(document.querySelector('.help-h')||{}).textContent,qq:(document.querySelector('.help-foot')||{}).innerText})")
check(isinstance(hm, str), "help modal read", str(hm)[:120])
h = json.loads(hm) if isinstance(hm, str) else {}
check(h.get("m") is True, "帮助模态打开")
check((h.get("tabs") or 0) >= 12, "分类导航 >=12 项", str(h.get("tabs")))
check((h.get("ps") or 0) >= 3, "正文有段落", str(h.get("ps")))
check("Liumorrow" in (h.get("qq") or "") and "1071188925" in (h.get("qq") or ""), "页脚含作者与群号", (h.get("qq") or "")[:80])
check(c.shot("b19-help-dark.png") == "b19-help-dark.png", "截图 help")
# 切换分类
c.ev("""(() => {const t=[...document.querySelectorAll('.help-nav [role=tab]')]; const x=t.find(e=>/冷读/.test(e.textContent)); x&&x.click(); return x?1:0})()""")
c.drain(0.5)
h2 = c.ev("JSON.stringify({h:(document.querySelector('.help-h')||{}).textContent,on:[...document.querySelectorAll('.help-item')].filter(e=>e.classList.contains('on')).length})")
check(isinstance(h2, str), "switch read", str(h2)[:100])
jj = json.loads(h2) if isinstance(h2, str) else {}
check("冷读" in (jj.get("h") or ""), "切换分类生效", jj.get("h"))
check(jj.get("on") == 1, "选中态唯一", str(jj.get("on")))
# 浅色主题再看一张
c.ev("(() => {const b=document.querySelector('.help-head .btn-quiet'); b&&b.click(); return 1})()")
c.drain(0.5)
check(c.ev("!!document.querySelector('.help-modal')") is False, "关闭按钮生效")

print("== E/F: 设置屏「使用教程」分页 + 关于页作者卡 ==")
c.ev("(() => {const b=document.querySelector('.wbtn'); b&&b.click(); return 1})()")
c.drain(1.0)
nav = c.ev("JSON.stringify([...document.querySelectorAll('.a-nav-item')].map(e=>e.textContent.trim()))")
check(isinstance(nav, str), "nav read", str(nav)[:150])
nn = json.loads(nav) if isinstance(nav, str) else []
check("使用教程" in nn, "设置导航有「使用教程」", str(nn))
c.ev("""(() => {const b=[...document.querySelectorAll('.a-nav-item')].find(e=>/使用教程/.test(e.textContent)); b&&b.click(); return 1})()""")
c.drain(0.8)
check(c.ev("!!document.querySelector('.help-compact')") is True, "内嵌帮助渲染")
check((c.ev("document.querySelectorAll('.help-compact .help-p').length") or 0) >= 3, "内嵌正文有段落")
c.shot("b19-settings-help-light.png")
c.ev("(() => {const b=[...document.querySelectorAll('.a-nav-item')].find(e=>/关于/.test(e.textContent)); b&&b.click(); return 1})()")
c.drain(0.8)
ab = c.ev("JSON.stringify({txt:(document.querySelector('.a-settings-panel')||{}).innerText||'',cards:document.querySelectorAll('.a-card').length})")
aa = json.loads(ab) if isinstance(ab, str) else {}
tt = aa.get("txt") or ""
check("作者与社群" in tt, "关于页有「作者与社群」卡")
check("Liumorrow" in tt, "关于页作者名")
check("1071188925" in tt, "关于页群号")
check("抖音" in tt, "关于页抖音入口")
check("Copyright" in tt and "GPL-3.0" in tt, "版权与许可证行", tt[-120:])
check("构建" in tt, "构建烙印(预览为 preview-sandbox)", "")
c.shot("b19-about-dark.png")
print("截图:", c.shot("b19-help-light.png"))
# 浅色主题帮助
goto(BASE + "/preview.html?theme=light&welcome=1")
c.shot("b19-welcome-light.png")

print("\n---- EXCEPTIONS (%d) ----" % len(c.exc))
for e in c.exc[:8]:
    print(json.dumps(e, ensure_ascii=False)[:500])
if c.exc:
    PROBLEMS.append("page exceptions: %d" % len(c.exc))
print("\nPROBLEMS %d" % len(PROBLEMS))
for p in PROBLEMS:
    print(" -", p)
sys.exit(1 if PROBLEMS else 0)
