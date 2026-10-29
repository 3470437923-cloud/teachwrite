"""按交互流程截图（气泡 / 思考块 / 工具行 / 备忘录 / 输入聚焦）。

用途：preview_shot.py 只能截静态首屏；本工具在加载后按脚本点几步再截，
用来验收需要交互才看得见的界面。同时它也是公共库：_a11y_check.py /
_contrast_audit.py / _style_audit.py 都从这里 import CDP、FLOWS、run_flow
（改签名会同时波及三者）。

前提：vite dev server（5183）+ 无头 Edge CDP（9223）已启动（口径见
docs/DEVELOPMENT.md）；pip install websocket-client。

用法：
    python tools/_shot_flow.py --out shots/_tmp --label chat --themes dark --flows chat
    (welcome 流程需要 URL 带 ?welcome=1,用 --query welcome=1 传)

已知坑：
    - FLOWS 里的选择器钉死了 mockBackend 的预置文案（会话标题
      「帮我续写第五章的结尾」、章节「第1章.md」、按钮「冷读本章」等）；
      改预置数据会让对应流程 miss，界面看似没截到交互态。
    - __type__ 用原生 setter + input 事件灌文本，绕开 IME；直接对
      textarea.value 赋值不会触发 React 状态更新。
    - CDP 连接取端口上第一个 page target，多个可调试浏览器同开时可能连错。
"""
import argparse
import json
import os
import time
import urllib.request

import websocket

FLOWS = {
    # 打开会话下拉 → 选一个有内容的会话（含 thinking 与 toolCalls）
    "chat": [
        (".sess-sel", 0.35),
        ('.sess-item[title="帮我续写第五章的结尾"]', 0.9),
    ],
    # 备忘录（模态）
    "memo": [
        ('.tb-btn[title="备忘录"]', 0.7),
    ],
    # 输入区聚焦（看 focus-within 的强调环）
    "composer": [
        ("__focus_composer__", 0.3),
        ("__type__:帮我给第六章写一个开头，要接住上一章的悬念。", 0.4),
    ],
    # 设置 → 主题分节（看主题卡与色板）
    "theme": [
        (".wbtn", 0.6),
        ("__nav__:主题", 0.6),
    ],
    # 设置 → 参数分节（看表单控件：输入井/开关/滑杆/分段）
    "params": [
        (".wbtn", 0.6),
        ("__nav__:参数", 0.6),
    ],
    # A-1 教训 x2:写死 nth-of-type 的序号是位置耦合 —— B19 插入「使用教程」后
    # about 变第 7 项,旧序号会静默测错视图;现在按文本点(__nav__)。
    "about": [
        (".wbtn", 0.6),
        ("__nav__:关于", 0.6),
    ],
    # 设置 → 使用教程分页（B19/D-053：与帮助弹层同一份 core/help.ts 的内嵌形态）
    "settings-help": [
        (".wbtn", 0.6),
        ("__nav__:使用教程", 0.6),
    ],
    # 标题栏「帮助」弹层（B19：分类导航 + 正文 + 页脚署名）
    "help": [
        ('.tb-btn[aria-label="使用教程"]', 0.8),
    ],
    # 首启欢迎弹窗（B19/D-053：需要 ?welcome=1，否则 mockBackend 视为已「不再显示」；
    # 本流程自身不点击，弹窗随页面加载出现）
    "welcome": [],
    # 真实发一条 → 等流式生成跑起来（看 .streaming 的边缘光晕与三点指示）
    "stream": [
        ("__focus_composer__", 0.3),
        ("__type__:帮我给第六章写一个开头，要接住上一章的悬念，读起来要像纸上的文字。", 0.4),
        (".send", 1.2),
    ],
    # 冷读对话框：先开一章，再点「冷读本章」
    "qmodal": [
        ("__text__:.tnode|第1章.md", 0.8),
        ("__text__:.chip|冷读本章", 0.7),
    ],
    # 纯编辑器视图：只看正文排版（字号/行高/字距/栏宽），不叠任何浮层
    "editor": [
        ("__text__:.tnode|第1章.md", 1.1),
    ],
    "none": [],
}

JS_CLICK_TEXT = """
(() => {
  const [sel, text] = %s;
  const els = [...document.querySelectorAll(sel)];
  const el = els.find((e) => (e.textContent || "").trim().includes(text));
  if (!el) return "miss:" + sel + "|" + text;
  el.scrollIntoView({block: "nearest"});
  el.click();
  return "ok";
})()
"""

# 按文本点设置屏导航(参数形如 "使用教程|AI 提供商")。
# 为什么不用 .a-nav-item:nth-of-type(N):序号是**位置耦合** —— B19 在「数据」与
# 「关于」之间插入「使用教程」后,所有写死 nth-of-type(6) 的 about 取证静默落在
# 帮助页上(A-1 的同型事故第二次发生)。文本才是稳定契约。
JS_NAV_TEXT = """
(() => {
  const want = %s;
  const els = [...document.querySelectorAll(".a-nav-item")];
  const el = els.find((e) => (e.textContent || "").trim() === want);
  if (!el) return "miss:" + want;
  el.click();
  return "ok";
})()
"""

JS_CLICK = """
(() => {
  const sel = %s;
  const el = document.querySelector(sel);
  if (!el) return "miss:" + sel;
  el.scrollIntoView({block: "nearest"});
  el.click();
  return "ok";
})()
"""

JS_FOCUS_COMPOSER = """
(() => {
  const el = document.querySelector(".composer-input");
  if (!el) return "miss";
  el.focus();
  return "ok";
})()
"""

JS_TYPE = """
(() => {
  const text = %s;
  const el = document.querySelector(".composer-input");
  if (!el) return "miss";
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return "ok";
})()
"""


class CDP:
    def __init__(self, port):
        data = json.loads(
            urllib.request.urlopen("http://127.0.0.1:%d/json" % port, timeout=8).read()
        )
        pages = [t for t in data if t.get("type") == "page"]
        if not pages:
            raise RuntimeError("no page target on port %d" % port)
        self.ws = websocket.create_connection(
            pages[0]["webSocketDebuggerUrl"], timeout=40, suppress_origin=True
        )
        self.mid = 0
        self.cmd("Page.enable")
        self.cmd("Runtime.enable")

    def cmd(self, method, **params):
        self.mid += 1
        mid = self.mid
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError("%s -> %s" % (method, msg["error"]))
                return msg.get("result", {})

    def eval(self, expr):
        r = self.cmd(
            "Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True
        )
        if "exceptionDetails" in r:
            d = r["exceptionDetails"]
            desc = (d.get("exception") or {}).get("description") or d.get("text")
            raise RuntimeError("JS 抛出异常: %s" % desc)
        return r.get("result", {}).get("value")

    def wait_ready(self, timeout=25.0, min_text=80):
        end = time.time() + timeout
        while time.time() < end:
            state = self.eval(
                "JSON.stringify({app: !!document.querySelector('.app-shell'),"
                "txt: (document.body.innerText||'').length})"
            )
            if state:
                d = json.loads(state)
                if d["app"] and d["txt"] >= min_text:
                    return True
            time.sleep(0.25)
        return False

    def shot(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        r = self.cmd("Page.captureScreenshot", format="png", captureBeyondViewport=False)
        import base64

        with open(path, "wb") as fh:
            fh.write(base64.b64decode(r["data"]))


def run_flow(c, steps, verbose):
    for sel, pause in steps:
        if sel.startswith("__focus_composer__"):
            res = c.eval(JS_FOCUS_COMPOSER)
        elif sel.startswith("__type__:"):
            res = c.eval(JS_TYPE % json.dumps(sel[len("__type__:"):]))
        elif sel.startswith("__nav__:"):
            res = c.eval(JS_NAV_TEXT % json.dumps(sel[len("__nav__:"):]))
        elif sel.startswith("__text__:"):
            spec = sel[len("__text__:"):].split("|", 1)
            res = c.eval(JS_CLICK_TEXT % json.dumps(spec))
        else:
            res = c.eval(JS_CLICK % json.dumps(sel))
        if verbose:
            print("      click %-52s -> %s" % (sel[:52], res))
        time.sleep(pause)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9223)
    ap.add_argument("--base", default="http://localhost:5183")
    ap.add_argument("--out", default=os.path.join("shots", "_tmp"))
    ap.add_argument("--label", default="flow")
    ap.add_argument("--themes", default="dark,light")
    ap.add_argument("--size", default="1600x1000")
    ap.add_argument("--flows", default="chat")
    ap.add_argument("--min-text", type=int, default=60)
    ap.add_argument(
        "--query",
        default="",
        help="extra URL query for preview.html, e.g. welcome=1 (首启弹窗验收)",
    )
    ap.add_argument(
        "--emulate",
        default="",
        help="emulated media features, ';'-separated, e.g. "
        "'prefers-reduced-motion:reduce;prefers-contrast:more'",
    )
    args = ap.parse_args()

    w, h = (int(x) for x in args.size.lower().split("x"))
    themes = [t.strip() for t in args.themes.split(",") if t.strip()]
    flows = [f.strip() for f in args.flows.split(",") if f.strip()]
    features = []
    for item in args.emulate.split(";"):
        item = item.strip()
        if not item:
            continue
        name, _, value = item.partition(":")
        features.append({"name": name.strip(), "value": value.strip()})

    c = CDP(args.port)
    ok = True
    for theme in themes:
        for flow in flows:
            c.cmd(
                "Emulation.setDeviceMetricsOverride",
                width=w,
                height=h,
                deviceScaleFactor=1,
                mobile=False,
            )
            c.cmd("Emulation.setEmulatedMedia", features=features)
            c.cmd("Page.navigate", url="%s/preview.html?theme=%s%s" % (
                args.base, theme, ("&" + args.query) if args.query else ""))
            if not c.wait_ready(min_text=args.min_text):
                print("FAIL %s/%s -> 页面未渲染" % (theme, flow))
                ok = False
                continue
            time.sleep(0.45)
            run_flow(c, FLOWS[flow], verbose=True)
            # 等动画落定再截（弹簧转场最长 ~0.5s）
            time.sleep(0.5)
            path = os.path.join(
                args.out, "%s-%s-%s-%s.png" % (args.label, flow, theme, args.size)
            )
            c.shot(path)
            print("  ok  %-9s %-9s -> %s" % (flow, theme, path))
            ok = False if not os.path.exists(path) else ok
    print("DONE" if ok else "HAD FAILURES")


if __name__ == "__main__":
    main()