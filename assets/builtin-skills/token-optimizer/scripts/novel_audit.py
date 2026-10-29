#!/usr/bin/env python3
"""Token Optimizer V9 - Novel-Specific Audit (P2)
Detects long-context inflation, formula repetition, character cache bloat,
and provides novel-writing-specific token optimization strategies.
"""
import os, sys, re

DEFAULT_SKILLS_DIR = os.path.join(os.path.expanduser("~"), "Documents", "skills")


def resolve_skills_dir():
    """Resolve the skills root that this script audits.

    Order: --skills-dir <path> / --skills-dir=<path> > env DEEPCOMPOSE_SKILLS_DIR
    > ~/Documents/skills (DeepCompose default; Documents\\skills on Windows).
    The override matters because the app lets the user move the skills root
    (prefs key custom_skills_dir).
    """
    argv = sys.argv[1:]
    for i, arg in enumerate(argv):
        if arg == "--skills-dir" and i + 1 < len(argv):
            return argv[i + 1]
        if arg.startswith("--skills-dir="):
            return arg.split("=", 1)[1]
    return os.environ.get("DEEPCOMPOSE_SKILLS_DIR") or DEFAULT_SKILLS_DIR


SKILLS_DIR = resolve_skills_dir()


def require_skills_dir():
    """Return False (and explain the fix) when the skills root does not exist."""
    if os.path.isdir(SKILLS_DIR):
        return True
    print("  [ERROR] skills directory not found: {}".format(SKILLS_DIR))
    print("  Use --skills-dir <path> or set DEEPCOMPOSE_SKILLS_DIR.")
    return False

# Novel skill keywords for identification
NOVEL_KEYWORDS = [
    "novel", "fiction", "story", "write", "author", "chapter", "plot",
    "character", "fanqie", "inkos", "creative", "narrative", "prose",
    "worldbuilding", "world-building", "dialogue", "scene", "outline",
]

# Inflation risk patterns - phrases that signal token waste in novel context
INFLATION_PATTERNS = [
    (r"完整的.{0,20}(人物|角色|世界观|大纲)", "full character/worldbuilding dump"),
    (r"(全部|所有|完整)的.{0,10}(章节|对话|场景)", "complete chapter/scene dump"),
    (r"输出.{0,10}字以上", "minimum word count requirement"),
    (r"不少于.{0,10}[字字符]", "minimum character count"),
    (r"详细.{0,5}(描述|展开|说明)", "detailed description requested"),
    (r"逐章.{0,10}(分析|检查|审查)", "per-chapter analysis"),
    (r"每个.{0,5}(人物|角色).{0,10}(档案|设定)", "per-character profile"),
    (r"全文|整部.{0,5}小说", "full novel context"),
    (r"所有.{0,5}(设定|细节|信息)", "all settings/details request"),
]

# Formula repetition patterns - detecting repeated structural templates
FORMULA_PATTERNS = [
    r"(首先|然后|接着|最后).{10,50}(首先|然后|接着|最后)",
    r"(第一步|第二步|第三步).{10,100}(第一步|第二步|第三步)",
    r"(在.{5,20}中.{5,30}){2,}",
    r"(\*\*注意.{5,50}\*\*){2,}",
]

# Character sheet patterns - detecting large character blocks
CHAR_PATTERNS = [
    r"人物.{0,5}(档案|卡|设定|介绍)",
    r"角色.{0,5}(档案|卡|设定|介绍|属性)",
    r"character.{0,10}(sheet|profile|card|info)",
]


def kb(b):
    return "{:.1f}".format(b / 1024)


def dir_size(path):
    if not os.path.isdir(path):
        return 0
    total = 0
    for root, dirs, files in os.walk(path):
        for f in files:
            fp = os.path.join(root, f)
            try:
                total += os.path.getsize(fp)
            except Exception:
                pass
    return total


def is_novel_skill(skill_dir):
    """Check if a skill is novel-related"""
    sf = os.path.join(skill_dir, "SKILL.md")
    if not os.path.isfile(sf):
        return False
    try:
        with open(sf, "r", encoding="utf-8", errors="ignore") as f:
            head = f.read(3000).lower()
    except Exception:
        return False
    return any(k in head for k in NOVEL_KEYWORDS)


def scan_inflation_risks(content):
    """Scan for context inflation risk patterns"""
    risks = []
    for pattern, desc in INFLATION_PATTERNS:
        matches = re.findall(pattern, content, re.IGNORECASE)
        if matches:
            risks.append({
                "pattern": desc,
                "count": len(matches),
                "samples": [str(m)[:80] for m in matches[:3]],
            })
    return risks


def scan_formula_repetition(content):
    """Detect formulaic structural repetition"""
    findings = []
    for pattern in FORMULA_PATTERNS:
        matches = re.findall(pattern, content, re.IGNORECASE)
        if matches:
            findings.append({
                "pattern": pattern[:50],
                "count": len(matches),
            })
    return findings


def scan_character_bloat(content):
    """Detect character sheet bloat"""
    findings = []
    for pattern in CHAR_PATTERNS:
        positions = [(m.start(), m.group()) for m in re.finditer(pattern, content, re.IGNORECASE)]
        if len(positions) > 3:
            findings.append({
                "type": "char_sheet_bloat",
                "count": len(positions),
                "pattern": pattern[:50],
                "positions": positions[:5],
            })
    return findings


def analyze_chapter_structure(content):
    """Check if content encourages per-chapter full context loading"""
    issues = []
    chapter_refs = len(re.findall(r"第[一二三四五六七八九十\d]+章", content))
    if chapter_refs > 10:
        issues.append("References {} individual chapters (risk of full-context loading)".format(chapter_refs))

    # Check for "keep context" / "remember" patterns
    context_hints = len(re.findall(r"(保持|保留|记住|维护).{0,20}(上下文|context|记忆)", content, re.IGNORECASE))
    if context_hints > 5:
        issues.append("{} explicit context-retention instructions (cache pressure)".format(context_hints))

    return issues


def main():
    print("=== Token Optimizer V9 - Novel-Specific Audit ===")
    print()

    if not require_skills_dir():
        sys.exit(2)  # N-34：与 token_audit 同口径——目录缺失是可预期失败，退出码 2

    # Find novel skills
    novel_skills = []
    for name in sorted(os.listdir(SKILLS_DIR)):
        d = os.path.join(SKILLS_DIR, name)
        if not os.path.isdir(d):
            continue
        if not is_novel_skill(d):
            continue

        sf = os.path.join(d, "SKILL.md")
        try:
            with open(sf, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
        except Exception:
            content = ""

        md_sz = os.path.getsize(sf)
        ref_sz = dir_size(os.path.join(d, "references"))
        sc_sz = dir_size(os.path.join(d, "scripts"))
        total = md_sz + ref_sz + sc_sz

        inflation = scan_inflation_risks(content)
        formulas = scan_formula_repetition(content)
        char_bloat = scan_character_bloat(content)
        chapter_issues = analyze_chapter_structure(content)

        novel_skills.append({
            "name": name,
            "total": total,
            "md_sz": md_sz,
            "ref_sz": ref_sz,
            "sc_sz": sc_sz,
            "inflation": inflation,
            "formulas": formulas,
            "char_bloat": char_bloat,
            "chapter_issues": chapter_issues,
        })

    print("  Novel skills found: {}".format(len(novel_skills)))
    print()

    if not novel_skills:
        print("  No novel-specific skills detected.")
        print()
        print("  --- General Novel Optimization Guide ---")
        print()
        print("  For novel writing scenarios:")
        print("    1. Progressive compression: checkpoint every 5 chapters")
        print("    2. Character cache: max 5 active POV characters in context")
        print("    3. World-building: externalize to memory files")
        print("    4. Inflation guard: detect formula repetition early")
        print("    5. Chapter context: summarize, don't dump full text")
        print()
        print("Done.")
        return

    # Sort by total size
    novel_skills.sort(key=lambda x: -x["total"])

    total_novel_kb = sum(s["total"] for s in novel_skills)
    print("  Total novel skill weight: {:.1f} KB".format(total_novel_kb / 1024))
    print()

    # Per-skill analysis
    for s in novel_skills:
        print("  --- {} ---".format(s["name"]))
        print("  Size: {:.0f}KB (MD:{:.0f} + REF:{:.0f} + SC:{:.0f})".format(
            s["total"] / 1024, s["md_sz"] / 1024, s["ref_sz"] / 1024, s["sc_sz"] / 1024))

        risk_score = 0

        if s["inflation"]:
            risk_score += len(s["inflation"]) * 2
            print("  [INFLATION RISK] {} patterns:".format(len(s["inflation"])))
            for r in s["inflation"]:
                print("    * {} (count={})".format(r["pattern"], r["count"]))
                risk_score += r["count"]

        if s["formulas"]:
            risk_score += len(s["formulas"]) * 2
            print("  [FORMULA REPETITION] {} patterns:".format(len(s["formulas"])))
            for f in s["formulas"]:
                print("    * matches={}".format(f["count"]))

        if s["char_bloat"]:
            risk_score += len(s["char_bloat"]) * 3
            print("  [CHARACTER BLOAT] {} patterns:".format(len(s["char_bloat"])))
            for c in s["char_bloat"]:
                print("    * {} char references ({} refs)".format(c["type"], c["count"]))

        if s["chapter_issues"]:
            risk_score += len(s["chapter_issues"]) * 2
            print("  [CHAPTER STRUCTURE ISSUES]:")
            for issue in s["chapter_issues"]:
                print("    * {}".format(issue))

        # Risk assessment
        if risk_score >= 10:
            print("  RISK: HIGH (score={}) - Aggressive compression recommended".format(risk_score))
            print("  ACTION: Apply L3 cache, compress chapter context every 3 chapters")
        elif risk_score >= 5:
            print("  RISK: MEDIUM (score={}) - Moderate compression".format(risk_score))
            print("  ACTION: Apply L2 cache, checkpoint every 5 chapters")
        elif risk_score > 0:
            print("  RISK: LOW (score={}) - Standard optimization".format(risk_score))
            print("  ACTION: Apply L1 cache, monitor inflation")
        else:
            print("  RISK: NONE - Good token hygiene")

        print()

    # Cross-skill summary
    print("  --- Cross-Skill Novel Optimization Summary ---")
    print()

    all_inflation = sum(len(s["inflation"]) for s in novel_skills)
    all_formulas = sum(len(s["formulas"]) for s in novel_skills)
    all_bloat = sum(len(s["char_bloat"]) for s in novel_skills)

    print("  Inflation risks detected: {}".format(all_inflation))
    print("  Formula repetitions:      {}".format(all_formulas))
    print("  Character bloat sources:  {}".format(all_bloat))
    print()

    # Top actions
    print("  TOP ACTIONS:")
    actions = []
    if all_inflation > 5:
        actions.append("Add inflation guards to {} novel skills".format(
            sum(1 for s in novel_skills if s["inflation"])))
    if all_formulas > 3:
        actions.append("Remove formulaic repetition in {} skills".format(
            sum(1 for s in novel_skills if s["formulas"])))
    if all_bloat > 2:
        actions.append("Limit character sheets to 5 active chars in {} skills".format(
            sum(1 for s in novel_skills if s["char_bloat"])))

    if not actions:
        # B12-8: "0 action items" must not mean "well optimized" while the summary
        # above still reports detected risks (measured: "Inflation risks detected: 5"
        # printed together with "Novel skills are well-optimized"). Below-threshold
        # findings are reported as such instead of being declared clean.
        detected = all_inflation + all_formulas + all_bloat
        if detected > 0:
            actions.append(
                "Below action threshold ({} inflation / {} formulas / {} bloat) - "
                "monitor and re-check after the next revision".format(
                    all_inflation, all_formulas, all_bloat))
        else:
            actions.append("Novel skills are well-optimized - monitor for inflation drift")

    for i, action in enumerate(actions):
        print("  {}. {}".format(i + 1, action))

    print()

    # Cache strategy recommendation
    print("  --- Recommended Novel Cache Strategy ---")
    print()
    print("  CHAPTER RANGE    CACHE LEVEL    STRATEGY")
    print("  Chapter 1-5      L1 (shallow)   Full text + character sheets")
    print("  Chapter 6-15     L2 (moderate)  Chapter summaries + active POV chars")
    print("  Chapter 16-30    L2 (moderate)  Chapter summaries, compress char sheets")
    print("  Chapter 31+      L3 (deep)      Scene summaries only, minimal chars")
    print()
    print("  Checkpoint actions at each level transition:")
    print("    L1->L2: Summarize chapters 1-5, drop inactive character details")
    print("    L2->L3: Archive chapters 6-30 as plot summaries, keep only")
    print("            currently active scene context")
    print()

    print("Done.")


if __name__ == "__main__":
    main()
