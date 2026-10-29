#!/usr/bin/env python3
"""Token Audit V9 - Full directory scan with refs/scripts detection"""
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

def kb(b):
    return f"{b/1024:.1f}"

def dir_size(path):
    if not os.path.isdir(path): return 0
    total = 0
    for root, dirs, files in os.walk(path):
        for f in files:
            fp = os.path.join(root, f)
            # N-56：裸 except 连 KeyboardInterrupt/SystemExit 一起吞，改窄
            try: total += os.path.getsize(fp)
            except OSError: pass
    return total

print("=== Token Audit V9 - Full Directory Scan ===")
print()

if not require_skills_dir():
    sys.exit(2)

skills = []
for name in os.listdir(SKILLS_DIR):
    d = os.path.join(SKILLS_DIR, name)
    sf = os.path.join(d, "SKILL.md")
    if not os.path.isdir(d) or not os.path.isfile(sf):
        continue
    md_sz = os.path.getsize(sf)
    ref_sz = dir_size(os.path.join(d, "references"))
    sc_sz = dir_size(os.path.join(d, "scripts"))
    total = md_sz + ref_sz + sc_sz
    
    # Category detection
    try:
        with open(sf, 'r', encoding='utf-8', errors='ignore') as f:
            head = f.read(2000).lower()
    except OSError:
        head = ""
    
    cat = "other"
    if any(k in head for k in ['novel','fiction','story','write','author','chapter','plot','character']):
        cat = "novel"
    elif any(k in head for k in ['code','dev','frontend','backend','api','react','vue','programming']):
        cat = "coding"
    elif any(k in head for k in ['finance','stock','trading','market']):
        cat = "finance"
    elif any(k in head for k in ['office','document','word','ppt','excel']):
        cat = "office"
    elif any(k in head for k in ['ai','gpt','llm','model','intelligence','agent']):
        cat = "ai"
    
    skills.append((name, md_sz, ref_sz, sc_sz, total, cat))

# Sort by total size descending
skills.sort(key=lambda x: -x[4])

# Display threshold-filtered
for name, md_sz, ref_sz, sc_sz, total, cat in skills:
    if total < 25600 and ref_sz <= 10240:
        continue
    tag = "[OK]   "
    if total >= 102400: tag = "[BLOAT]"
    elif total >= 51200: tag = "[EMERG]"
    elif total >= 35840: tag = "[CRIT] "
    elif total >= 25600: tag = "[WARN] "
    
    hidden = ""
    if ref_sz > 10240:
        hidden = f" HIDDEN:{kb(ref_sz)}KB-refs"
    
    print(f"  {tag} {name:<30} SKL:{kb(md_sz):>5} + REF:{kb(ref_sz):>5} = {kb(total):>5} KB{hidden}")

total_md = sum(s[1] for s in skills)
total_ref = sum(s[2] for s in skills)
total_sc = sum(s[3] for s in skills)
total_all = total_md + total_ref + total_sc
hidden_count = sum(1 for s in skills if s[2] > 10240)

print()
print("=== Summary ===")
print(f"  Skills scanned:      {len(skills)}")
print(f"  SKILL.md only:       {kb(total_md)} KB")
print(f"  References/ hidden:  {kb(total_ref)} KB  <- BLIND SPOT")
print(f"  Scripts/:            {kb(total_sc)} KB")
print(f"  GRAND TOTAL:         {kb(total_all)} KB (~{total_all//4} tokens)")
print(f"  Hidden refs >10KB:   {hidden_count} skills")
print()

cats = {}
for _, _, _, _, _, cat in skills:
    cats[cat] = cats.get(cat, 0) + 1
print(f"  Categories: {cats}")
print()

# Self-check
# N-35：自检段假定 skills 根里必有 token-optimizer —— 审计自定义目录
#（--skills-dir 指向别处）时 os.path.getsize 直接 FileNotFoundError，
# 前面全部输出作废。目录不存在就明说并跳过，不当"必崩"处理。
self_d = os.path.join(SKILLS_DIR, "token-optimizer")
self_sf = os.path.join(self_d, "SKILL.md")
if os.path.isfile(self_sf):
    self_md = os.path.getsize(self_sf)
    self_sc = dir_size(os.path.join(self_d, "scripts"))
    self_total = self_md + self_sc
    print(f"  TO self-cost: {kb(self_total)} KB (~{self_total//4} tokens)")
else:
    print("  TO self-cost: (token-optimizer not in this skills root, skipped)")
print()
print("Done.")
