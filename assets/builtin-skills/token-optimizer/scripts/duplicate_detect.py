#!/usr/bin/env python3
"""Token Optimizer V9 - Duplicate Skill Detection (P0)
Detects duplicate/near-duplicate skills by normalized name and description overlap.
"""
import os, sys, re, hashlib

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

def normalize(name):
    """Normalize skill name: lowercase, remove hyphens, underscores, spaces"""
    n = name.lower()
    n = re.sub(r'[-_\s]+', '', n)
    return n

def extract_info(skill_path):
    """Extract name, description, trigger words from SKILL.md"""
    sf = os.path.join(skill_path, "SKILL.md")
    if not os.path.isfile(sf):
        return None
    try:
        with open(sf, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
    except OSError:  # N-56：裸 except 连 KeyboardInterrupt 都吞
        return None
    
    info = {"content": content}
    # Extract name from frontmatter
    m = re.search(r'^name:\s*(.+)$', content, re.MULTILINE)
    info["name"] = m.group(1).strip() if m else os.path.basename(skill_path)
    
    # Extract description
    # A-5：旧正则写成 /s（字母斜杠 s）而非 \s —— description 永远匹配不到，
    # 0.3 权重的"描述重叠"维度从上线起就是死的。
    m = re.search(r'^description:\s*(.+)$', content, re.MULTILINE)
    info["desc"] = m.group(1).strip() if m else ""
    
    # Extract triggers
    triggers = re.findall(r'^  -\s*"(.+)"', content, re.MULTILINE)
    info["triggers"] = triggers
    
    # Content fingerprint (first 2KB normalized)
    head = re.sub(r'\s+', ' ', content[:2000].lower())
    info["fingerprint"] = hashlib.md5(head.encode()).hexdigest()
    
    return info

def name_similarity(a, b):
    """Check if two normalized names are similar"""
    na, nb = normalize(a), normalize(b)
    if na == nb:
        return 1.0
    if na in nb or nb in na:
        return 0.8
    # Shared character ratio
    common = len(set(na) & set(nb))
    total = len(set(na) | set(nb))
    return common / total if total > 0 else 0

def desc_overlap(desc_a, desc_b):
    """Simple word overlap ratio between descriptions"""
    if not desc_a or not desc_b:
        return 0
    wa = set(re.findall(r'\w+', desc_a.lower()))
    wb = set(re.findall(r'\w+', desc_b.lower()))
    if not wa or not wb:
        return 0
    return len(wa & wb) / len(wa | wb)

def is_numeric_id(name):
    """Check if name is a generated numeric skill ID (skill_ + 19 digits)"""
    return bool(re.match(r'^skill_\d{19}$', name))

def find_duplicates(skills_info):
    """Find duplicate pairs"""
    pairs = []
    names = list(skills_info.keys())
    for i in range(len(names)):
        for j in range(i+1, len(names)):
            a, b = names[i], names[j]
            
            # Skip numeric-ID vs numeric-ID comparisons (always false positives)
            if is_numeric_id(a) and is_numeric_id(b):
                continue
            
            ia, ib = skills_info[a], skills_info[b]
            
            ns = name_similarity(ia["name"], ib["name"])
            ds = desc_overlap(ia["desc"], ib["desc"])
            
            # Duplicate criteria
            score = 0
            reasons = []
            
            if ns >= 0.8:
                score += 0.5
                reasons.append(f"name_sim={ns:.2f}")
            if ds >= 0.4:
                score += 0.3
                reasons.append(f"desc_overlap={ds:.2f}")
            if ns >= 0.6 and ds >= 0.3:
                score += 0.2
                reasons.append("combined_name_desc_match")
            if ia["fingerprint"] == ib["fingerprint"]:
                score = 1.0
                reasons.append("fingerprint_identical")
            
            if score >= 0.5:
                pairs.append({
                    "a": a, "b": b,
                    "name_a": ia["name"], "name_b": ib["name"],
                    "score": score,
                    "reasons": reasons,
                    "triggers_a": ia["triggers"],
                    "triggers_b": ib["triggers"]
                })
    
    return sorted(pairs, key=lambda x: -x["score"])

def main():
    print("=== Token Optimizer V9 - Duplicate Skill Detection ===")
    print()

    if not require_skills_dir():
        sys.exit(2)  # N-34：与 token_audit 同口径——目录缺失是可预期失败，退出码 2
    
    # Scan all skills
    skills_info = {}
    for name in os.listdir(SKILLS_DIR):
        d = os.path.join(SKILLS_DIR, name)
        if not os.path.isdir(d):
            continue
        info = extract_info(d)
        if info:
            skills_info[name] = info
    
    print(f"  Skills scanned: {len(skills_info)}")
    print()
    
    # Find duplicates
    dups = find_duplicates(skills_info)
    
    if not dups:
        print("  [OK] No duplicate skills detected.")
        print()
        return
    
    print(f"  [WARN] Found {len(dups)} potential duplicate pairs:")
    print()
    
    for i, d in enumerate(dups):
        tag = "[IDENTICAL]" if d["score"] >= 0.9 else "[HIGH_OVERLAP]"
        print(f"  {i+1}. {tag} Score: {d['score']:.2f}")
        print(f"     A: {d['name_a']} ({d['a']})")
        print(f"     B: {d['name_b']} ({d['b']})")
        print(f"     Reasons: {', '.join(d['reasons'])}")
        
        # Show trigger overlap
        ta = set(d["triggers_a"])
        tb = set(d["triggers_b"])
        common_triggers = ta & tb
        if common_triggers:
            print(f"     Shared triggers: {list(common_triggers)[:5]}")
        
        # Recommendation
        if d["score"] >= 0.9:
            print(f"     ACTION: Keep one, remove the other. Prefer the better-maintained copy.")
        elif d["score"] >= 0.7:
            print(f"     ACTION: Merge overlapping features or clearly differentiate.")
        else:
            print(f"     ACTION: Review manually - may be false positive.")
        print()
    
    # Summary by risk level
    high = sum(1 for d in dups if d["score"] >= 0.9)
    med = sum(1 for d in dups if 0.7 <= d["score"] < 0.9)
    low = sum(1 for d in dups if d["score"] < 0.7)
    print(f"  Risk breakdown: {high} HIGH | {med} MEDIUM | {low} LOW")
    print()
    
    # Top actionable recommendation
    if high > 0:
        print(f"  TOP ACTION: Resolve {high} high-overlap duplicate pair(s) first.")
    elif med > 0:
        print(f"  TOP ACTION: Review {med} medium-overlap pair(s) for possible merge.")
    print()
    print("Done.")

if __name__ == "__main__":
    main()
