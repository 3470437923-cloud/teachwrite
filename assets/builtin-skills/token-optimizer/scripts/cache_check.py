#!/usr/bin/env python3
"""Token Optimizer V9 - Cache Strategy Check with Novel-Specific L1/L2/L3 Analysis (P2)
Analyzes cache friendliness, detects opportunities for prefix standardization,
and provides novel-specific progressive compression guidance.
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

# Cache configuration per domain
CACHE_STRATEGIES = {
    "novel": {
        "L1": {"name": "Shallow Cache", "depth": 1, "retention": "Full text recall",
               "trigger": ">70% context free", "action": "Keep full chapter text + character sheets"},
        "L2": {"name": "Moderate Cache", "depth": 2, "retention": "Chapter summaries + active chars",
               "trigger": "40-70% context free", "action": "Summary per chapter, POV characters only"},
        "L3": {"name": "Deep Cache", "depth": 3, "retention": "Scene-level summaries only",
               "trigger": "<40% context free", "action": "Compress every 5 chapters, drop non-active chars"},
    },
    "coding": {
        "L1": {"name": "Shallow Cache", "depth": 1, "retention": "Full file content",
               "trigger": ">70% context free", "action": "Keep all relevant source files"},
        "L2": {"name": "Moderate Cache", "depth": 2, "retention": "Function signatures + key logic",
               "trigger": "40-70% context free", "action": "Summarize file purpose, key functions only"},
        "L3": {"name": "Deep Cache", "depth": 3, "retention": "Module-level summaries",
               "trigger": "<40% context free", "action": "Keep only module contracts and interfaces"},
    },
    "other": {
        "L1": {"name": "Shallow Cache", "depth": 1, "retention": "Full context retention",
               "trigger": ">70% context free", "action": "Standard caching"},
        "L2": {"name": "Moderate Cache", "depth": 2, "retention": "Key points + summaries",
               "trigger": "40-70% context free", "action": "Summarize key decisions"},
        "L3": {"name": "Deep Cache", "depth": 3, "retention": "Critical info only",
               "trigger": "<40% context free", "action": "Minimal essential context"},
    },
}


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


def categorize_skill(skill_dir):
    sf = os.path.join(skill_dir, "SKILL.md")
    if not os.path.isfile(sf):
        return "other"
    try:
        with open(sf, "r", encoding="utf-8", errors="ignore") as f:
            head = f.read(2000).lower()
    except Exception:
        return "other"

    if any(k in head for k in ["novel", "fiction", "story", "write", "author", "chapter", "plot"]):
        return "novel"
    if any(k in head for k in ["code", "dev", "frontend", "backend", "api", "react", "vue"]):
        return "coding"
    return "other"


def analyze_prefix_fixity(content):
    """Check how fixable the content prefix is (for cache optimization)"""
    if not content:
        return 0, []

    lines = content.split("\n")
    # Find where the content becomes "variable" (after frontmatter + intro)
    fixed_lines = 0
    in_frontmatter = False
    fm_done = False

    for line in lines:
        stripped = line.strip()
        if stripped == "---" and not fm_done:
            if not in_frontmatter:
                in_frontmatter = True
            else:
                in_frontmatter = False
                fm_done = True
            fixed_lines += 1
            continue
        if in_frontmatter:
            fixed_lines += 1
            continue
        # Post-frontmatter: count fixed content until first "variable" marker
        if not fm_done:
            continue
        fixed_lines += 1
        # Stop counting as "fixed" after seeing variable markers
        if any(m in stripped.lower() for m in [
            "example", "user input", "dynamic", "runtime", "variable"
        ]):
            break

    # Check for common cache-unfriendly patterns
    cache_issues = []
    if re.search(r"\{+\s*user\s*", content, re.IGNORECASE):
        cache_issues.append("dynamic user placeholders in prefix")
    if re.search(r"date|time|timestamp|current", content[:1000].lower()):
        cache_issues.append("time-based content in early position")
    if len(re.findall(r"```", content)) > 10:
        cache_issues.append("many code blocks fragment cache")

    fixity = fixed_lines / len(lines) * 100 if lines else 0
    return fixity, cache_issues


def main():
    print("=== Token Optimizer V9 - Cache Strategy Check ===")
    print()

    if not require_skills_dir():
        sys.exit(2)  # N-34：与 token_audit 同口径——目录缺失是可预期失败，退出码 2

    # Determine dominant domain
    domain_counts = {}
    skill_list = []
    total_skill_kb = 0

    for name in sorted(os.listdir(SKILLS_DIR)):
        d = os.path.join(SKILLS_DIR, name)
        if not os.path.isdir(d):
            continue
        sf = os.path.join(d, "SKILL.md")
        if not os.path.isfile(sf):
            continue

        cat = categorize_skill(d)
        sz = dir_size(d)
        total_skill_kb += sz
        domain_counts[cat] = domain_counts.get(cat, 0) + 1

        content = ""
        try:
            with open(sf, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
        except Exception:
            pass

        fixity, issues = analyze_prefix_fixity(content)
        skill_list.append((name, cat, sz, fixity, issues))

    if not domain_counts:
        print("  [WARN] No skills found.")
        return

    dominant = max(domain_counts, key=domain_counts.get)

    # Determine current cache level
    context_budget_kb = 500
    remaining = (context_budget_kb - total_skill_kb / 1024) / context_budget_kb * 100
    if remaining > 70:
        current_level = "L1"
    elif remaining > 40:
        current_level = "L2"
    else:
        current_level = "L3"

    strategies = CACHE_STRATEGIES.get(dominant, CACHE_STRATEGIES["other"])
    strategy = strategies[current_level]

    print("  Dominant domain: {}".format(dominant))
    print("  Total skill weight: {:.1f} KB".format(total_skill_kb / 1024))
    print("  Context remaining: {:.0f}%".format(remaining))
    print("  Recommended cache level: {} - {}".format(current_level, strategy["name"]))
    print()

    # Cache strategy details
    print("  --- Cache Level Guide ({}) ---".format(dominant))
    print()
    for level in ["L1", "L2", "L3"]:
        s = strategies[level]
        marker = "-> " if level == current_level else "   "
        print("  {}[{}] {} (depth={})".format(marker, level, s["name"], s["depth"]))
        print("       Trigger: {}".format(s["trigger"]))
        print("       Action:  {}".format(s["action"]))
        print()

    # Prefix fixity report
    print("  --- Prefix Fixity Report ---")
    print()
    skill_list.sort(key=lambda x: x[3])
    low_fixity = [s for s in skill_list if s[3] < 40]
    if low_fixity:
        print("  Low prefix fixity (cache-unfriendly, <40%):")
        for name, cat, sz, fixity, issues in low_fixity[:10]:
            issue_str = ", ".join(issues[:3]) if issues else "no issues detected"
            print("    {:<35} fixity={:.0f}%  [{:<8}] {}".format(
                name, fixity, cat, issue_str))
        if len(low_fixity) > 10:
            print("    ... and {} more".format(len(low_fixity) - 10))
    else:
        print("  All skills have good prefix fixity (>40%).")
    print()

    # Domain-specific optimization tips
    print("  --- Domain-Specific Optimization ---")
    print()

    if dominant == "novel":
        print("  Novel Writing Cache Strategy:")
        print("    1. Character cache: keep active POV characters (max 5) in full detail")
        print("    2. Chapter context: progressive compression every 5 chapters")
        print("    3. World-building: store in memory files, not in-skill context")
        print("    4. Inflation risk: detect repeated formulas (see novel-audit.py)")
        print("    5. Checkpoint: compress chapter context at chapter 5, 10, 20, 50")
        print()
        print("  CACHE LEVEL     WHEN                        ACTION")
        print("  L1 (shallow)    Chapter 1-5, new arc start  Full text + all chars")
        print("  L2 (moderate)   Chapter 6-30                 Chapter summaries + active chars")
        # N-37: "Chapter 31+" matches SKILL.md section 6 and novel_audit.py;
        # the old "30+" overlapped chapter 30 with the L2 band (6-30)
        print("  L3 (deep)       Chapter 31+, long arcs       Scene summaries only")
    elif dominant == "coding":
        print("  Coding Cache Strategy:")
        print("    1. Prefix: fixed imports + constants at top")
        print("    2. Dynamic: user code in the middle/end")
        print("    3. File references: use paths, not full content")
        print("    4. Test data: externalize to files")
    else:
        print("  General Cache Strategy:")
        print("    1. Fix system instructions at prompt start")
        print("    2. User context at prompt end")
        print("    3. Template standard output structures")

    print()
    print("  QUICK ACTION: {} cache level active - {}".format(current_level, strategy["action"]))
    print()
    print("Done.")


if __name__ == "__main__":
    main()
