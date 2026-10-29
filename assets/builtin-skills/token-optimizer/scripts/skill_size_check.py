#!/usr/bin/env python3
"""Token Optimizer V9 - Skill Health Check with Full Directory Audit (P0 extended)
Scans SKILL.md + references/ + scripts/ for complete size analysis.
Detects hidden weight, content density, and provides actionable triage.
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

# Thresholds (in bytes). N-38: bands and labels must match SKILL.md section 2.1:
#   < 15KB OK | 15-25KB NOTE | 25-35KB WARN | 35-50KB CRIT | 50-100KB EMERG | > 100KB BLOAT
# The old table was shifted one band down (15-25KB reported "OK", >=100KB reported
# "EMERG", BLOAT missing entirely) -- docs and tool disagreed on every size.
THRESHOLDS = [
    (15360,   "NOTE",   "Check if reducible"),
    (25600,   "WARN",   "Run slim-down"),
    (35840,   "CRIT",   "Must slim or split"),
    (51200,   "EMERG",  "Split or retire immediately"),
    (102400,  "BLOAT",  "Force split"),
]

# Density markers - patterns indicating philosophical/non-actionable prose
DENSITY_MARKERS = [
    r'\u54f2\u5b66',      # philosophy/哲学
    r'\u7406\u8bba\u6846\u67b6',  # theoretical framework/理论框架
    r'\u5efa\u8bae(?![^。]*\u6267\u884c)',  # suggest without execute/建议(不含执行)
    r'\u5f39\u6027\u56e0\u5b50',  # elasticity factor/弹性因子
    r'\u7528\u6237\u53ef\u8986\u76d6',   # user may override/用户可覆盖
    r'\u81ea\u7531\u7248',       # free version/自由版
    r'\u8bf4\u660e[：:]',        # explanation:/说明：
    r'\u672c\u6587\u6863',       # this document/本文档
    r'\u53c2\u8003\u6587\u732e',  # references/参考文献
    r'permission\s+system',
    r'access\s+control',
    r'the\s+philosophy',
    r'design\s+philosophy',
    r'core\s+principle',
    r'best\s+practice',
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


def get_threshold_level(sz):
    for limit, level, _ in reversed(THRESHOLDS):
        if sz >= limit:
            return level
    return "OK"


def analyze_density(content):
    """Analyze content density: ratio of actionable to philosophical content"""
    if not content:
        return 0, 0, []

    lines = content.split("\n")
    total_lines = len(lines)

    # Count actionable lines (code blocks, commands, checklists, table rows)
    actionable = 0
    fluff_markers_hit = []

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        # Actionable patterns
        if re.match(r'^[-\*]\s', stripped):  # bullet point
            actionable += 1
        elif re.match(r'^[|#]', stripped):   # table or heading
            actionable += 1
        elif re.match(r'^```', stripped):     # code block
            actionable += 1
        elif re.match(r'^\d+\.\s', stripped):  # numbered list
            actionable += 1
        elif 'bash ' in stripped.lower() or 'npm ' in stripped.lower() or 'python ' in stripped.lower():
            actionable += 1

    # Check density markers
    for marker in DENSITY_MARKERS:
        try:
            if re.search(marker, content, re.IGNORECASE):
                fluff_markers_hit.append(marker[:30])
        except Exception:
            pass

    density = actionable / total_lines * 100 if total_lines > 0 else 0
    return density, len(fluff_markers_hit), fluff_markers_hit[:5]


def main():
    print("=== Token Optimizer V9 - Skill Health Check (Full Directory) ===")
    print()

    if not require_skills_dir():
        sys.exit(2)  # N-34：与 token_audit 同口径——目录缺失是可预期失败，退出码 2

    skills = []
    for name in sorted(os.listdir(SKILLS_DIR)):
        d = os.path.join(SKILLS_DIR, name)
        if not os.path.isdir(d):
            continue
        sf = os.path.join(d, "SKILL.md")
        if not os.path.isfile(sf):
            continue

        md_sz = os.path.getsize(sf)
        ref_sz = dir_size(os.path.join(d, "references"))
        sc_sz = dir_size(os.path.join(d, "scripts"))
        ast_sz = dir_size(os.path.join(d, "assets"))
        total = md_sz + ref_sz + sc_sz + ast_sz

        # Read content for density analysis
        content = ""
        try:
            with open(sf, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
        except Exception:
            pass

        density, fluff_count, fluff_markers = analyze_density(content)

        level = get_threshold_level(total)
        hidden = ref_sz + ast_sz

        skills.append((name, md_sz, ref_sz, sc_sz, ast_sz, total, hidden, level, density, fluff_count, fluff_markers))

    # Sort by total size descending
    skills.sort(key=lambda x: -x[5])

    # Summary stats
    total_md = sum(s[1] for s in skills)
    total_ref = sum(s[2] for s in skills)
    total_sc = sum(s[3] for s in skills)
    total_ast = sum(s[4] for s in skills)
    total_all = total_md + total_ref + total_sc + total_ast

    print("  Skills found: {}".format(len(skills)))
    print("  SKILL.md total:     {} KB".format(kb(total_md)))
    print("  references/ total:  {} KB  <- HIDDEN".format(kb(total_ref)))
    print("  scripts/ total:     {} KB".format(kb(total_sc)))
    print("  assets/ total:      {} KB".format(kb(total_ast)))
    print("  GRAND TOTAL:        {} KB (~{} tokens)".format(kb(total_all), total_all // 4))
    print()

    # Health report by level
    levels = {}
    for s in skills:
        lv = s[7]
        if lv not in levels:
            levels[lv] = []
        levels[lv].append(s)

    for lv in ["BLOAT", "EMERG", "CRIT", "WARN", "NOTE", "OK"]:
        if lv not in levels:
            continue
        items = levels[lv]
        icon = {"BLOAT": "!!", "EMERG": "!!", "CRIT": "!!", "WARN": "! ", "NOTE": "~ ", "OK": "  "}.get(lv, "  ")
        print("  [{}] {} ({} skills):".format(lv, icon, len(items)))
        for name, md_sz, ref_sz, sc_sz, ast_sz, total, hidden, _, density, fluff, _ in items:
            hidden_flag = ""
            if hidden > 10240:
                hidden_flag = " [HIDDEN:{:.0f}KB]".format(hidden / 1024)
            density_flag = ""
            # B12-8: SKILL.md defines "low density" as actionable-line ratio < 40%,
            # but this flag used to fire on fluff-marker *count* (>=3) while printing
            # a percentage -- measured output claimed "[LOW-DENS:52%]" (52% is the
            # mid band per the docs). Judge the documented threshold; marker count
            # gets its own honest label.
            if density < 40:
                density_flag = " [LOW-DENS:{:.0f}%]".format(density)
            elif fluff >= 3:
                density_flag = " [FLUFF-MARKERS:{}]".format(fluff)
            print("      {:<35} {:.0f}KB = MD:{:.0f} + REF:{:.0f} + SC:{:.0f}{}{}".format(
                name, total / 1024, md_sz / 1024, ref_sz / 1024, sc_sz / 1024,
                hidden_flag, density_flag))
        print()

    # Density report - bottom 10 by actionable ratio
    print("  --- Content Density Analysis (bottom 10) ---")
    print()
    skills_by_density = sorted(skills, key=lambda x: x[8])
    for name, md_sz, ref_sz, sc_sz, ast_sz, total, hidden, level, density, fluff, markers in skills_by_density[:10]:
        if fluff == 0:
            continue
        print("  {:<35} density={:.0f}%  fluff={}  markers={}".format(
            name, density, fluff, markers[:3] if markers else "none"))

    if not any(s[9] > 0 for s in skills_by_density[:10]):
        print("  (All skills have good content density)")

    print()

    # Triage recommendations
    print("  --- Triage Recommendations ---")
    print()

    bloat = levels.get("BLOAT", [])
    emerg = levels.get("EMERG", [])
    crit = levels.get("CRIT", [])
    warn = levels.get("WARN", [])

    top = bloat + emerg
    if top:
        print("  TOP PRIORITY - Immediate Action ({} skills):".format(len(top)))
        for name, _, _, _, _, total, hidden, _, _, _, _ in top:
            total_kb = total / 1024
            action = "SPLIT into sub-skills" if total_kb > 80 else "SLIM by 50%"
            if hidden > 51200:
                action += " - check references/ ({:.0f}KB hidden)".format(hidden / 1024)
            print("    * {}: {} KB -> {}".format(name, total_kb, action))
        print()

    if crit:
        print("  HIGH PRIORITY ({} skills):".format(len(crit)))
        for name, _, _, _, _, total, hidden, _, _, _, _ in crit:
            total_kb = total / 1024
            action = "Run 4-step slim-down"
            if hidden > 25600:
                action += ", audit references/ ({:.0f}KB)".format(hidden / 1024)
            print("    * {}: {} KB -> {}".format(name, total_kb, action))
        print()

    if warn:
        print("  WATCH LIST ({} skills):".format(len(warn)))
        for name, _, _, _, _, total, hidden, _, _, _, _ in warn[:5]:
            total_kb = total / 1024
            print("    * {}: {} KB - consider slim-down".format(name, total_kb))
        if len(warn) > 5:
            print("    ... and {} more".format(len(warn) - 5))
        print()

    # Overall health score (N-38: BLOAT counts as unhealthy too)
    total_skills = len(skills)
    unhealthy = len(levels.get("BLOAT", [])) + len(emerg) + len(crit)
    health_pct = (total_skills - unhealthy) / total_skills * 100 if total_skills > 0 else 100

    print("  Overall health: {:.0f}% skills healthy ({}/{} unhealthy)".format(
        health_pct, unhealthy, total_skills))
    print()

    print("Done.")


if __name__ == "__main__":
    main()
