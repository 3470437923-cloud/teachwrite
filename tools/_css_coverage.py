"""类名覆盖校验：旧 CSS 的每个类 token 必须在新 CSS 里有落点。

用途：CSS 重构的安全网。对比三方类名 token：
    1) git HEAD 上的旧样式（app.css / glass.css / tokens.css）；
    2) src/**/*.tsx 里出现的全部 className；
    3) src/styles/*.css 里当前定义的全部类名。
报告：旧有新无（漏掉的组件）、JSX 用而未定义（会裸奔）、定义而无人引用
（冗余，仅提示）。

用法：
    python tools/_css_coverage.py    # 需要 git 命令行可用

退出码（E-3 统一口径）：0 = 通过；1 = 有漏项；2 = 基线丢失（旧 CSS 已不在
HEAD 上，对比无从谈起——是重构窗口期的一次性验收工具，不是常驻检查）。
**基线丢失绝不能当"通过"退出**：旧脚本此时静默给出"旧有新无 0 项"，
看起来全绿，其实什么都没比。

已知坑：
    - className={...} 表达式已剔除比较操作数（见下方行内注释），但更复杂的
      模板串拼接仍可能漏提或误提类名。
    - 仓库根目录从本脚本位置推导（tools/ 的上一级），不再写死盘符路径。
"""
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = str(Path(__file__).resolve().parent.parent)
STYLES = os.path.join(ROOT, "src", "styles")

COMMENT = re.compile(r"/\*[\s\S]*?\*/")


def tokens_of(text):
    text = COMMENT.sub("", text)
    return set(re.findall(r"\.([a-zA-Z][a-zA-Z0-9_-]*)", text))


def git_show(path):
    out = subprocess.run(
        ["git", "-C", ROOT, "show", "HEAD:" + path],
        capture_output=True,
    )
    return out.returncode, out.stdout.decode("utf-8", "replace")


old = set()
baseline_missing = []
for p in ("src/styles/app.css", "src/styles/glass.css", "src/styles/tokens.css"):
    rc, text = git_show(p)
    if rc != 0 or not text.strip():
        # A-4：HEAD 上已没有这个旧文件 —— 记下来而不是把空串当基线
        baseline_missing.append(p)
        continue
    old |= tokens_of(text)

if baseline_missing:
    print("基线丢失（HEAD 上已无旧 CSS，本脚本失去对比对象）：")
    for p in baseline_missing:
        print("   %s" % p)
    print("仍可参考的旧 token 数: %d" % len(old))
    sys.exit(2)

new = set()
for name in sorted(os.listdir(STYLES)):
    if name.endswith(".css"):
        with open(os.path.join(STYLES, name), encoding="utf-8") as fh:
            new |= tokens_of(fh.read())

# JSX 里也可能出现旧 CSS 未覆盖的类（新增组件）
tsx = set()
for base, _dirs, files in os.walk(os.path.join(ROOT, "src")):
    for fn in files:
        if not fn.endswith(".tsx"):
            continue
        with open(os.path.join(base, fn), encoding="utf-8") as fh:
            src = fh.read()
        for m in re.finditer(r'className="([^"]*)"', src):
            tsx |= set(m.group(1).split())
        for m in re.finditer(r"className=\{([^}]*)\}", src):
            expr = m.group(1)
            # 先剔除比较操作数：`className={tab === "cloud" ? "a" : "b"}` 里
            # 的 "cloud" 是被比较的**状态值**，不是类名。不剔掉的话会报出
            # .cloud / .lan / .全部 / .失败 这类假裸奔（曾经确实误报过）。
            expr = re.sub(r'[=!]==?\s*"[^"]*"', "", expr)
            for q in re.finditer(r'"([^"]*)"', expr):
                tsx |= set(q.group(1).split())

IGNORE = {"org", "w3"}  # data-URI 里 http://www.w3.org 的误报

missing_old = sorted(old - new - IGNORE)
missing_jsx = sorted(tsx - new - IGNORE)

print("旧 CSS token 数: %d" % len(old - IGNORE))
print("JSX  token 数: %d" % len(tsx - IGNORE))
print("新 CSS token 数: %d" % len(new))

print("\n!! 旧 CSS 有、新 CSS 没有（漏掉的组件）: %d" % len(missing_old))
for t in missing_old:
    print("   .%s" % t)

print("\n!! JSX 用、新 CSS 没有（会裸奔）: %d" % len(missing_jsx))
for t in missing_jsx:
    print("   .%s" % t)

# 新 CSS 里定义了但没人用的（冗余，仅提示）
unused = sorted(new - old - tsx)
print("\n-- 新 CSS 定义但无人引用（%d，新增设施或冗余）--" % len(unused))
for t in unused:
    print("   .%s" % t)

# E-3：漏项必须以非零退出码收尾 —— 这脚本曾被当闸门用，但它从来
# 不设退出码，"有漏项"和"全通过"在外部看来一模一样。
if missing_old or missing_jsx:
    sys.exit(1)
sys.exit(0)