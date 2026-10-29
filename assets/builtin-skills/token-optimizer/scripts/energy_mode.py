#!/usr/bin/env python3
"""Token Optimizer V9 - Energy Mode Execution Engine (P1)
Executable three-tier energy mode with domain-specific context budgets.
Monitors skill sizes and outputs the appropriate energy mode for the current context.
"""
import os, sys

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

# Domain-specific context budgets (in KB)
DOMAIN_BUDGETS = {
    "novel": {
        "eco":       {"max_skill_kb": 15, "max_output_lines": 30,  "cache_depth": 3},
        "efficient": {"max_skill_kb": 25, "max_output_lines": 60,  "cache_depth": 2},
        "normal":    {"max_skill_kb": 40, "max_output_lines": 120, "cache_depth": 1},
    },
    "coding": {
        "eco":       {"max_skill_kb": 12, "max_output_lines": 40,  "cache_depth": 3},
        "efficient": {"max_skill_kb": 20, "max_output_lines": 80,  "cache_depth": 2},
        "normal":    {"max_skill_kb": 35, "max_output_lines": 160, "cache_depth": 1},
    },
    "finance": {
        "eco":       {"max_skill_kb": 10, "max_output_lines": 25,  "cache_depth": 3},
        "efficient": {"max_skill_kb": 18, "max_output_lines": 50,  "cache_depth": 2},
        "normal":    {"max_skill_kb": 30, "max_output_lines": 100, "cache_depth": 1},
    },
    "office": {
        "eco":       {"max_skill_kb": 10, "max_output_lines": 35,  "cache_depth": 3},
        "efficient": {"max_skill_kb": 18, "max_output_lines": 70,  "cache_depth": 2},
        "normal":    {"max_skill_kb": 30, "max_output_lines": 140, "cache_depth": 1},
    },
    "ai": {
        "eco":       {"max_skill_kb": 15, "max_output_lines": 40,  "cache_depth": 3},
        "efficient": {"max_skill_kb": 25, "max_output_lines": 80,  "cache_depth": 2},
        "normal":    {"max_skill_kb": 40, "max_output_lines": 160, "cache_depth": 1},
    },
    "other": {
        "eco":       {"max_skill_kb": 12, "max_output_lines": 30,  "cache_depth": 3},
        "efficient": {"max_skill_kb": 20, "max_output_lines": 60,  "cache_depth": 2},
        "normal":    {"max_skill_kb": 35, "max_output_lines": 120, "cache_depth": 1},
    },
}

# N-37: bands must match SKILL.md section 3.2 and cache_check.py triggers:
# ECO < 40% remaining, EFFICIENT 40-70%, NORMAL > 70%. The old 50.0 contradicted
# both documented sources (a 45%-remaining context reported "eco" here but
# "efficient/L2" everywhere else).
ECO_THRESHOLD = 40.0
EFFICIENT_THRESHOLD = 70.0


def categorize_skill(skill_dir):
    """Categorize a skill by its description keywords"""
    sf = os.path.join(skill_dir, "SKILL.md")
    if not os.path.isfile(sf):
        return "other"
    try:
        with open(sf, "r", encoding="utf-8", errors="ignore") as f:
            head = f.read(2000).lower()
    except Exception:
        return "other"

    cats = [
        ("novel",   ["novel", "fiction", "story", "write", "author", "chapter", "plot"]),
        ("coding",  ["code", "dev", "frontend", "backend", "api", "react", "vue", "programming"]),
        ("finance", ["finance", "stock", "trading", "market", "fund", "invest"]),
        ("office",  ["office", "document", "word", "ppt", "excel", "pdf"]),
        ("ai",      ["ai", "gpt", "llm", "model", "intelligence", "agent"]),
    ]
    for cat, keywords in cats:
        if any(k in head for k in keywords):
            return cat
    return "other"


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


def get_energy_mode(context_budget_kb, total_skill_bytes):
    if context_budget_kb <= 0:
        return "eco"
    total_skill_kb_real = total_skill_bytes / 1024
    remaining_pct = (context_budget_kb - total_skill_kb_real) / context_budget_kb * 100
    if remaining_pct < ECO_THRESHOLD:
        return "eco"
    elif remaining_pct < EFFICIENT_THRESHOLD:
        return "efficient"
    else:
        return "normal"


def print_instructions(mode, domain, budget):
    """Generate actionable mode instructions for a specific domain"""
    data = {
        "eco": [
            ("ECO MODE - MAXIMUM CONSERVATION", ""),
            ("Only load skills essential to the current task", ""),
            ("Target: loaded skill total under {} KB".format(budget["max_skill_kb"]), ""),
            ("Output: max {} lines per response".format(budget["max_output_lines"]), ""),
            ("Cache depth: {} (aggressive compression)".format(budget["cache_depth"]), ""),
            ("Skip: all non-essential audits, health checks, cosmetic analysis", ""),
            ("Priority: complete the task with minimal token overhead", ""),
        ],
        "efficient": [
            ("EFFICIENT MODE - BALANCED CONSERVATION", ""),
            ("Load domain-essential skills, defer non-critical ones", ""),
            ("Target: loaded skill total under {} KB".format(budget["max_skill_kb"]), ""),
            ("Output: max {} lines per response".format(budget["max_output_lines"]), ""),
            ("Cache depth: {} (moderate compression)".format(budget["cache_depth"]), ""),
            ("Run: quick audit only (skip deep scan)", ""),
        ],
        "normal": [
            ("NORMAL MODE - FULL CAPABILITY", ""),
            ("All relevant skills loaded freely", ""),
            ("Target: loaded skill total under {} KB".format(budget["max_skill_kb"]), ""),
            ("Output: max {} lines per response".format(budget["max_output_lines"]), ""),
            ("Cache depth: {} (standard)".format(budget["cache_depth"]), ""),
            ("Run: full audit and health checks as needed", ""),
        ],
    }

    novel_extras = {
        "eco": [
            "Novel-specific: compress chapter context every 5 chapters",
            "Novel-specific: drop full character sheets, keep active characters only",
            "Novel-specific: use L3 deep cache (summaries only, no full text recall)",
        ],
        "efficient": [
            "Novel-specific: keep last 3 chapters in full context",
            "Novel-specific: character sheets for active POV characters only",
            "Novel-specific: use L2 moderate cache with chapter summaries",
        ],
        "normal": [
            "Novel-specific: full character sheets, all chapters context",
            "Novel-specific: L1 shallow cache (full text recall capability)",
        ],
    }

    lines = data.get(mode, data["normal"])
    for line, _ in lines:
        print("  - " + line)

    if domain == "novel":
        extras = novel_extras.get(mode, [])
        for line in extras:
            print("  - " + line)


def parse_context_budget(argv):
    """Context budget in KB (default 500) taken from the first positional argument.

    Flags are skipped so both orders work, e.g.
    `python energy_mode.py 300 --skills-dir D:\\skills`.
    """
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--skills-dir":
            i += 2
            continue
        if arg.startswith("--skills-dir="):
            i += 1
            continue
        try:
            return int(arg)
        except ValueError:
            i += 1
    return 500


def main():
    print("=== Token Optimizer V9 - Energy Mode Engine ===")
    print()

    if not require_skills_dir():
        sys.exit(2)  # N-34：与 token_audit 同口径——目录缺失是可预期失败，退出码 2

    context_budget_kb = parse_context_budget(sys.argv[1:])

    print("  Context budget: {} KB".format(context_budget_kb))
    print()

    domain_counts = {}
    total_skill_bytes = 0
    skill_list = []

    for name in sorted(os.listdir(SKILLS_DIR)):
        d = os.path.join(SKILLS_DIR, name)
        if not os.path.isdir(d):
            continue
        sf = os.path.join(d, "SKILL.md")
        if not os.path.isfile(sf):
            continue

        cat = categorize_skill(d)
        sz = dir_size(d)
        total_skill_bytes += sz
        domain_counts[cat] = domain_counts.get(cat, 0) + 1
        skill_list.append((name, cat, sz))

    if not domain_counts:
        print("  [WARN] No skills found.")
        return

    dominant = max(domain_counts, key=domain_counts.get)
    total_skill_kb = total_skill_bytes / 1024
    mode = get_energy_mode(context_budget_kb, total_skill_bytes)
    budget = DOMAIN_BUDGETS.get(dominant, DOMAIN_BUDGETS["other"])[mode]

    remaining = context_budget_kb - total_skill_kb
    print("  Dominant domain: {} ({} skills)".format(dominant, domain_counts[dominant]))
    print("  Total skill weight: {:.1f} KB".format(total_skill_kb))
    print("  Context remaining: {:.0f} KB".format(remaining))
    print("  Energy mode: {}".format(mode.upper()))
    print()

    print("  Domain breakdown:")
    for cat in sorted(domain_counts, key=lambda x: -domain_counts[x]):
        cat_total = sum(s[2] for s in skill_list if s[1] == cat)
        pct = cat_total / total_skill_bytes * 100 if total_skill_bytes > 0 else 0
        print("    {:<10}: {:>3} skills, {:>6.1f} KB ({:>4.1f}%)".format(
            cat, domain_counts[cat], cat_total / 1024, pct))
    print()

    print("  --- Energy Mode Instructions ({}) ---".format(mode.upper()))
    print()
    print_instructions(mode, dominant, budget)
    print()

    # Skill load recommendations
    skill_list.sort(key=lambda x: -x[2])
    cutoff = budget["max_skill_kb"] * 1024

    print("  --- Load Recommendations (budget: {} KB/skill) ---".format(budget["max_skill_kb"]))
    print()

    to_load = []
    to_defer = []
    current_load = 0

    for name, cat, sz in skill_list:
        if cat == dominant and current_load + sz <= cutoff * 3:
            to_load.append((name, cat, sz))
            current_load += sz
        elif cat != dominant and current_load + sz <= cutoff:
            to_load.append((name, cat, sz))
            current_load += sz
        else:
            to_defer.append((name, cat, sz))

    print("  LOAD ({} skills, {:.1f} KB):".format(len(to_load), current_load / 1024))
    for name, cat, sz in to_load:
        print("    + {:<42} [{:<8}] {:.1f} KB".format(name, cat, sz / 1024))

    if to_defer:
        defer_total = sum(s[2] for s in to_defer)
        print("  DEFER ({} skills, {:.1f} KB):".format(len(to_defer), defer_total / 1024))
        for name, cat, sz in to_defer[:10]:
            print("    - {:<42} [{:<8}] {:.1f} KB".format(name, cat, sz / 1024))
        if len(to_defer) > 10:
            print("    ... and {} more".format(len(to_defer) - 10))

    print()
    actions = {
        "eco": "load only essentials",
        "efficient": "load domain skills, defer others",
        "normal": "full audit allowed",
    }
    print("  QUICK ACTION: {} mode - {}".format(mode.upper(), actions.get(mode, "")))
    print()
    print("Done.")


if __name__ == "__main__":
    main()
