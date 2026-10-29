"""CDP 验证工具：通过 Chrome DevTools 协议直接驱动 DeepCompose 应用页面。

用途：物理屏幕关闭/会话锁定时，仍可完成 UI 交互验证（点击、eval 读状态、
截图）——交互与截图都走 CDP，不经过操作系统桌面。

前提（A-6 修正：真机默认**不开**远程调试）：
    - 应用侧需以调试参数启动 WebView2 才有 9223 端口：
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9223"
        然后从同一 shell 启动 DeepCompose。产物/安装副本不带此参数，
        src-tauri 也没有配置它 —— 那是刻意的（发布版不开调试口）。
    - 无该端口时，本工具实际能连的是 preview 流程那台无头 Edge（9223），
      即 preview_shot.py / _a11y_check.py 使用的同一目标。
    - pip install websocket-client。

用法：
    python tools/cdp_probe.py eval "document.title"
    python tools/cdp_probe.py click 'button.wbtn[title="设置"]'
    python tools/cdp_probe.py shot out.png
    python tools/cdp_probe.py alive          # 连通性检查（eval 1+1）

已知坑：
    - 支持的 action 只有 eval / click / shot / alive；旧文档示例里的
      "exists" 从未实现，传入会按 unknown action 退出。
    - 点击选择器必须是**当前真实 DOM** 的类名（旧示例 ".b-icon-btn.gear"
      是玻璃时代的类，早已不存在；齿轮现在是 button.wbtn[title="设置"]）。
    - 优先挑 URL 含 "tauri" 的 page target，兜底取第一个 page；同时开着
      多个可调试实例时可能连错目标。
    - 端口 9223 硬编码在模块级 PORT，改端口需同步 docs 口径。
"""
import base64
import json
import sys
import urllib.request
import websocket  # pip install websocket-client

PORT = 9223


def find_target():
    data = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=5).read())
    for t in data:
        if t.get("type") == "page" and "tauri" in (t.get("url") or ""):
            return t["webSocketDebuggerUrl"]
    # 兜底：第一个 page
    for t in data:
        if t.get("type") == "page":
            return t["webSocketDebuggerUrl"]
    raise SystemExit("no page target: " + json.dumps(data[:3]))


class CDP:
    def __init__(self):
        url = find_target()
        self.ws = websocket.create_connection(url, timeout=15, suppress_origin=True)
        self.mid = 0

    def cmd(self, method, **params):
        self.mid += 1
        mid = self.mid
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(json.dumps(msg["error"]))
                return msg.get("result", {})

    def eval(self, expr):
        r = self.cmd("Runtime.evaluate", expression=expr, returnByValue=True)
        return r.get("result", {}).get("value")

    def click(self, selector):
        expr = f"""
        (() => {{
          const el = document.querySelector({json.dumps(selector)});
          if (!el) return "MISSING:" + {json.dumps(selector)};
          el.click();
          return "CLICKED";
        }})()
        """
        return self.eval(expr)

    def shot(self, out):
        r = self.cmd("Page.captureScreenshot", format="png")
        data = base64.b64decode(r["data"])
        open(out, "wb").write(data)
        return out


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "eval"
    arg = sys.argv[2] if len(sys.argv) > 2 else ""
    c = CDP()
    if action == "eval":
        print(json.dumps(c.eval(arg), ensure_ascii=False, default=str))
    elif action == "click":
        print(c.click(arg))
    elif action == "shot":
        print("SAVED", c.shot(arg))
    elif action == "alive":
        print(c.eval("1+1"))
    else:
        raise SystemExit("unknown action: " + action)


if __name__ == "__main__":
    main()
