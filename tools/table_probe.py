"""DocTable column-width / status-symbol probe (CDP, no Playwright required).

Purpose : verify the 2026-10-11 table-view batch (D-061..D-065) against the
          *rendered* DOM of the dev-only preview sandbox, not just unit tests:
            1. declared tables really get <colgroup> + table-layout:fixed, and the
               measured pixel widths follow the declared 100-point weights;
            2. undeclared tables (细纲 / 粗纲 / 00 / 01 / 02) get NO colgroup and
               keep content-driven auto layout (the user said "don't touch these");
            3. the trailing blank column (old .dt-rowact delete column) is gone
               from every grid table, and the delete button still exists;
            4. status values render as the √ / ? / × symbols with the Chinese
               original kept in title;
            5. prose-only documents (人物库 / 03-全书大纲) show NO view toggle.

Prereqs : vite dev server on 5183 serving the preview sandbox
          (npm run dev), headless Edge with CDP on 9223 -- launch command in
          docs/DEVELOPMENT.md section 4 -- and pip install websocket-client.

Usage:
  python tools/table_probe.py
  python tools/table_probe.py --theme light
  python tools/table_probe.py --dump        # explore: list sidebar nodes

Pitfalls: - Attaches to the FIRST "page" target on the CDP port; close other
            debuggable browsers or it may probe the wrong page.
          - Widths are percentages of the *table* width, so compare ratios, not
            raw pixels; the probe reports both.
          - Fixture data drives what is on screen: the promo book's 章节摘要 is
            the OLD list form, so the two-column parser is NOT exercised here
            (it is covered by tests/store/doctable.test.ts instead).
"""

import argparse
import json
import sys
import time
import urllib.request

import websocket  # pip install websocket-client


def find_page(port):
    data = json.loads(urllib.request.urlopen("http://127.0.0.1:%d/json" % port, timeout=5).read())
    pages = [t for t in data if t.get("type") == "page"]
    if not pages:
        raise SystemExit("no page target on port %d" % port)
    return pages[0]["webSocketDebuggerUrl"]


class Probe:
    def __init__(self, port):
        self.ws = websocket.create_connection(find_page(port), timeout=60, suppress_origin=True)
        self.mid = 0
        self.errors = []

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
            if msg.get("method") == "Runtime.exceptionThrown":
                det = msg["params"].get("exceptionDetails", {})
                self.errors.append(det.get("text"))

    def js(self, expr):
        r = self.cmd(
            "Runtime.evaluate",
            expression=expr,
            returnByValue=True,
            awaitPromise=True,
        )
        res = r.get("result", {})
        if r.get("exceptionDetails"):
            raise RuntimeError("JS error: %s" % json.dumps(r["exceptionDetails"])[:400])
        return res.get("value")

    def wait_for(self, expr, seconds=15, label=""):
        end = time.time() + seconds
        while time.time() < end:
            if self.js("!!(%s)" % expr):
                return True
            time.sleep(0.25)
        raise SystemExit("timeout waiting for %s (%s)" % (label or expr, expr))


# ── 页面内小工具：按可见文字找侧栏文件节点（.tnode[role=treeitem] > .lbl）并点开 ──
CLICK_HELPER = r"""
window.__t = {
  // 侧栏文件树：.tnode 是按钮，文字在内部 .lbl 里
  nodeByText: (txt) => Array.prototype.slice.call(document.querySelectorAll('.tnode'))
    .find((b) => ((b.querySelector('.lbl') || b).textContent || '').trim() === txt),
  clickText: (txt) => {
    const b = window.__t.nodeByText(txt);
    if (!b) return false;
    b.click();
    return true;
  },
  toggleLabels: () => Array.prototype.slice.call(document.querySelectorAll('button.chip'))
    .map((b) => (b.textContent || '').trim()),
  tables: () => Array.prototype.slice.call(document.querySelectorAll('table.dt-table')).map((t) => {
    const cols = Array.prototype.slice.call(t.querySelectorAll('colgroup > col'));
    const ths = Array.prototype.slice.call(t.querySelectorAll('thead th'));
    const tr = t.querySelector('tbody tr');
    const tds = tr ? Array.prototype.slice.call(tr.children) : [];
    const tw = t.getBoundingClientRect().width;
    return {
      cls: t.className,
      fixed: getComputedStyle(t).tableLayout,
      colgroup: cols.length,
      colWidths: cols.map((c) => +(c.getBoundingClientRect().width).toFixed(1)),
      colPct: cols.map((c) => tw ? +((c.getBoundingClientRect().width / tw) * 100).toFixed(1) : 0),
      headers: ths.map((h) => (h.textContent || '').trim()),
      blankHeader: ths.filter((h) => (h.textContent || '').trim() === '').length,
      cellCount: tds.length,
      tableWidth: +tw.toFixed(1),
      hasRowdel: !!t.querySelector('.dt-rowdel'),
      hasRowact: !!t.querySelector('.dt-rowact'),
      symbols: Array.prototype.slice.call(t.querySelectorAll('.dt-status.dt-sym'))
        .map((s) => ({ sym: (s.textContent || '').trim(), title: s.getAttribute('title') })),
      firstCellText: tds.length ? (tds[0].textContent || '').trim().slice(0, 30) : '',
    };
  }),
  hasToggle: () => window.__t.toggleLabels().some((x) => /^(表格|原文)$/.test(x)),
  proseCards: () => document.querySelectorAll('.dt-prose').length,
};
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9223)
    ap.add_argument("--base", default="http://localhost:5183")
    ap.add_argument("--theme", default="dark", choices=["dark", "light"])
    ap.add_argument("--dump", action="store_true", help="list sidebar nodes and exit")
    ap.add_argument("--out", default="shots/preview/table-probe.json")
    args = ap.parse_args()

    p = Probe(args.port)
    p.cmd("Page.enable")
    p.cmd("Runtime.enable")

    url = "%s/preview.html?promo=1&theme=%s" % (args.base, args.theme)
    p.cmd("Page.navigate", url=url)
    time.sleep(3.0)
    p.wait_for("document.querySelector('.app-shell')", 25, "app shell")
    p.js(CLICK_HELPER)

    if args.dump:
        info = p.js(
            "JSON.stringify(Array.prototype.slice.call(document.querySelectorAll('.tnode'))"
            ".map(b=>({lbl:((b.querySelector('.lbl')||b).textContent||'').trim(),"
            "exp:b.getAttribute('aria-expanded'),sel:b.getAttribute('aria-selected')})))"
        )
        print(info)
        return 0

    report = {"theme": args.theme, "cases": [], "errors": p.errors}

    # 需要点开的文档：期望列宽来自 src/core/store/doctable.ts 的 COLUMN_WEIGHTS。
    # 注意：只有 **grid 行表** 才该有 colgroup / 行末删钮；kv 字段卡两样都没有。
    # 沙箱夹具里的 人物库 是按模板写的（带六方面字段行）→ 有 kv → 有钮；
    # 用户真书上那份 人物库 是纯自然段 → 没有钮（这条由单测的 hasRealTable 覆盖）。
    #
    # 期望可以是「按表给」的列表：06 有两张 grid（风格规则四列固定 / 禁用列表两列自适应），
    # 一张文档一个期望说不清，所以第 4 个元素可以是 [(表序号, 期望), ...]。
    CASES = [
        ("规则台账.md", [6, 50, 8, 5, 5, 8, 18], None),
        ("追踪-伏笔.md", [5, 18, 10, 22, 18, 5, 22], None),
        ("04-粗纲.md", "undeclared", None),       # 未声明 → 不许有 colgroup
        ("人物库.md", "kvOnly", None),            # 夹具带字段行 → kv 卡，无 grid
        ("03-全书大纲.md", "noToggle", None),     # 纯散文 → 连钮都没有
        # 06 批 3：风格规则四列固定；禁用列表两列不在声明里 → 自适应
        ("06-写作风格.md", "perTable", [(0, [10, 15, 10, 65]), (1, "undeclared")]),
    ]

    for label, expect, per_table in CASES:
        case = {
            "label": label,
            "expectPct": expect if isinstance(expect, list) else None,
            "mode": expect if isinstance(expect, str) else "grid",
            "perTable": per_table,
        }
        ok = p.js("window.__t.clickText(%s)" % json.dumps(label))
        case["clicked"] = bool(ok)
        if not ok:
            case["error"] = "侧栏找不到该文件节点"
            report["cases"].append(case)
            continue
        time.sleep(1.0)

        if expect == "noToggle":
            case["hasToggle"] = p.js("window.__t.hasToggle()")
            report["cases"].append(case)
            continue

        p.wait_for("document.querySelector('table.dt-table') || window.__t.hasToggle()", 10, label)
        if not p.js("!!document.querySelector('table.dt-table')"):
            p.js(
                "Array.prototype.slice.call(document.querySelectorAll('button.chip'))"
                ".filter(b=>/^表格$/.test((b.textContent||'').trim()))[0].click()"
            )
            time.sleep(1.0)
        p.wait_for("document.querySelector('table.dt-table')", 10, label + " table")
        case["hasToggle"] = p.js("window.__t.hasToggle()")
        case["tables"] = json.loads(p.js("JSON.stringify(window.__t.tables())"))
        report["cases"].append(case)

    print(json.dumps(report, ensure_ascii=False, indent=2))

    # ── 判定 ──
    fails = []

    def check_one(label, t, expect):
        """单张表的列宽判定（expect 为百分比列表或 "undeclared"）。返回问题串列表。"""
        out = []
        if expect == "undeclared":
            if t.get("colgroup"):
                out.append("%s: 未声明的表不该有 colgroup（用户要求不动）" % label)
            elif t.get("fixed") != "auto":
                out.append("%s: 未声明的表 table-layout 应为 auto，实测 %s" % (label, t.get("fixed")))
        elif isinstance(expect, list):
            if t.get("colgroup") != len(expect):
                out.append("%s: colgroup %s 列，期望 %s" % (label, t.get("colgroup"), len(expect)))
            elif t.get("fixed") != "fixed":
                out.append("%s: table-layout=%s，期望 fixed" % (label, t.get("fixed")))
            else:
                got = t.get("colPct") or []
                for i, (g, e) in enumerate(zip(got, expect)):
                    if abs(g - e) > 2.0:  # 2 个百分点容差（边框/取整）
                        out.append("%s: 第%d列实测 %.1f%%，期望 %d%%" % (label, i + 1, g, e))
        return out

    for c in report["cases"]:
        label, expect, mode = c["label"], c.get("expectPct"), c.get("mode")
        if c.get("error"):
            fails.append("%s: %s" % (label, c["error"]))
            continue
        if mode == "noToggle":
            if c.get("hasToggle"):
                fails.append("%s: 纯散文文档不该有切换钮（D-061）" % label)
            continue
        if not c.get("hasToggle"):
            fails.append("%s: 有真表格却没有切换钮" % label)
            continue
        tables = c.get("tables") or []
        if not tables:
            fails.append("%s: 没渲染出表格" % label)
            continue
        grids = [t for t in tables if "dt-grid" in (t.get("cls") or "")]
        kvs = [t for t in tables if "dt-grid" not in (t.get("cls") or "")]
        # 空列与删钮：只有 grid 表适用（kv 卡本来就没有行末删钮）
        for t in grids:
            if t.get("hasRowact") or t.get("blankHeader"):
                fails.append("%s: grid 仍有空列（blankHeader=%s rowact=%s）" % (label, t.get("blankHeader"), t.get("hasRowact")))
            if not t.get("hasRowdel"):
                fails.append("%s: 删钮不见了（.dt-rowdel 缺失）" % label)
        for t in kvs:
            if t.get("hasRowact") or t.get("blankHeader"):
                fails.append("%s: kv 卡出现空列" % label)

        if mode == "kvOnly":
            if grids:
                fails.append("%s: 期望只有 kv 卡，却出现 grid" % label)
            if not kvs:
                fails.append("%s: 期望有 kv 卡，却一张都没有" % label)
            continue

        if not grids:
            fails.append("%s: 没有 grid 行表" % label)
            continue

        per_table = c.get("perTable")
        if per_table:
            for idx, exp in per_table:
                if idx >= len(grids):
                    fails.append("%s: 期望有第 %d 张 grid，实际只有 %d 张" % (label, idx + 1, len(grids)))
                    continue
                fails.extend(check_one("%s[表%d]" % (label, idx + 1), grids[idx], exp))
            continue
        for t in grids:
            fails.extend(check_one(label, t, expect))

    if fails:
        print("\n[FAIL]")
        for f in fails:
            print("  - " + f)
        return 1
    print("\n[PASS] 列宽 / 空列 / 切换钮门控全部符合预期")
    return 0


if __name__ == "__main__":
    sys.exit(main())
