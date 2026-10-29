"""06-写作风格.md 格式迁移（B22 批 3）：自然段 → ### SR-编号 块。

纪律：**规则文字从原文件里切出来，不由人手重打** —— 逐字保留由构造保证。
切分口径：段落按 `。` 断句（句号随前句），再按分组规格合成规则；拼回来必须与原文逐字节相同。

用法：
  python tools/migrate_style_sr.py --file <06 路径> --check     # 只校验，不写盘
  python tools/migrate_style_sr.py --file <06 路径> --write     # 写盘（先落 .bak）
"""
import argparse
import io
import os
import re
import shutil
import sys

# 每段切成几条规则（按句数分组）；句 = 以 。结尾
GROUPS = [
    [2, 1, 2, 1],  # P1 基调 / 视角 / 场景 / 心理
    [2, 1, 2],     # P2 情绪 / 对话功能 / 对话完整度
    [1, 1, 1, 1],  # P3 语言 / 时间 / 重复 / 意象
    [1, 1, 1],     # P4 篇幅 / 人物 / 描写
    [4],           # P5 真实感（整段一条）
    [2, 1, 1],     # P6 段落 / 语气词 / 评述与表态
    [2],           # P7 台词成分补足（整段一条）
    [1],           # P8 用词与删减
]

# (规则分类, 规则来源) —— 与 GROUPS 展平后一一对应
META = [
    ("基调", "本书既定"),
    ("视角", "本书既定"),
    ("场景", "本书既定"),
    ("心理", "本书既定"),
    ("情绪", "本书既定"),
    ("对话", "本书既定"),
    ("对话", "手改回流·GL-002/GL-011"),
    ("语言", "本书既定"),
    ("时间", "本书既定"),
    ("重复", "本书既定"),
    ("意象", "本书既定"),
    ("篇幅", "本书既定"),
    ("人物", "本书既定"),
    ("描写", "本书既定"),
    ("真实感", "手改回流·GL-006"),
    ("段落", "手改回流·GL-001"),
    ("对话", "手改回流·GL-002"),
    ("对话", "手改回流·GL-003/GL-004"),
    ("对话", "手改回流·GL-007"),
    ("用词", "手改回流·GL-005"),
]


def split_sentences(p):
    """按 `。` 断句，句号随前句；末段没有句号也照收。"""
    out, cur = [], ""
    for ch in p:
        cur += ch
        if ch == "。":
            out.append(cur)
            cur = ""
    if cur:
        out.append(cur)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    with io.open(args.file, encoding="utf-8", newline="") as f:
        raw = f.read()
    eol = "\r\n" if "\r\n" in raw else "\n"
    text = raw.replace("\r\n", "\n")
    lines = text.split("\n")

    # 定位「## 风格规则」节与「## 禁用列表」节
    try:
        i_rules = lines.index("## 风格规则")
        i_ban = lines.index("## 禁用列表")
    except ValueError:
        print("[SKIP] 找不到「## 风格规则」/「## 禁用列表」两节；可能已迁移过")
        return 0

    # 节内自然段（非空、非标题行）
    paras = [l for l in lines[i_rules + 1 : i_ban] if l.strip() and not l.startswith("#")]
    if len(paras) != len(GROUPS):
        print("[FAIL] 自然段数 %d ≠ 分组规格 %d（文件可能已迁移或结构不同）" % (len(paras), len(GROUPS)))
        return 1

    # 展平成规则
    rules = []
    for p, spec in zip(paras, GROUPS):
        sents = split_sentences(p)
        if sum(spec) != len(sents):
            print("[FAIL] 断句数 %d ≠ 分组和 %d：%s" % (len(sents), sum(spec), p[:30]))
            return 1
        k = 0
        for n in spec:
            rules.append("".join(sents[k : k + n]))
            k += n

    if len(rules) != len(META):
        print("[FAIL] 规则数 %d ≠ META %d" % (len(rules), len(META)))
        return 1

    # ★ 核心不变量：拼回来必须与原文逐字节相同
    joined = "".join(rules)
    original = "".join(paras)
    if joined != original:
        print("[FAIL] 逐字校验不通过：拼接结果与原文不一致")
        for i, (a, b) in enumerate(zip(joined, original)):
            if a != b:
                print("  首个差异 @%d: 新=%r 原=%r" % (i, joined[max(0, i - 20) : i + 20], original[max(0, i - 20) : i + 20]))
                break
        print("  长度：新 %d / 原 %d" % (len(joined), len(original)))
        return 1
    print("[OK] 逐字校验通过：%d 条规则，%d 字符，与原文逐字节相同" % (len(rules), len(joined)))

    # 生成新节
    body = []
    for i, (txt, (cat, src)) in enumerate(zip(rules, META), start=1):
        body.append("### SR-%03d" % i)
        body.append("- 规则分类：%s" % cat)
        body.append("- 规则来源：%s" % src)
        body.append("- 具体内容：%s" % txt)
        body.append("")
    new_rules_section = body  # 末尾已带一个空行

    new_lines = lines[: i_rules + 1] + [""] + new_rules_section + lines[i_ban:]
    new_text = "\n".join(new_lines)
    if eol != "\n":
        new_text = new_text.replace("\n", eol)

    if args.check:
        print("[CHECK] 未写盘。新文件预览（前 12 行）：")
        for l in new_text.split(eol)[:12]:
            print("   " + l)
        return 0

    if args.write:
        shutil.copyfile(args.file, args.file + ".bak-b22")
        with io.open(args.file, "w", encoding="utf-8", newline="") as f:
            f.write(new_text)
        print("[WRITE] 已写入；备份 %s.bak-b22" % args.file)
        return 0

    print("需要 --check 或 --write")
    return 2


if __name__ == "__main__":
    sys.exit(main())
