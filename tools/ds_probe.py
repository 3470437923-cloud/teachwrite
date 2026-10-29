#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""DeepSeek 官方接口 P0 实测探针（B5 用，只读本机 prefs，绝不打印 Key）。

用途：把 `docs/KNOWN-LIMITS.md` 里 KL-DF-01/02/03/04/05/07 的 `[待实测]` 变成 `[已实测]`。
设计纪律：
  * Key 只从 `%APPDATA%\\com.writerd\\writerD\\shared_preferences.json` 的 `flutter.api_key` 读，
    **不落盘、不进参数、不出现在任何输出里**（输出统一过 redact()）；
  * 只发短请求（max_tokens 小、提示词短），把真实花费压在几毛钱以内；
  * 纯标准库（urllib），不依赖第三方包，避免污染项目依赖；
  * 逐条打印 ASCII 单行 JSON，方便 PowerShell 控制台读取（中文会被 GBK 控制台糟蹋）。

用法：
    python tools/ds_probe.py --only balance
    python tools/ds_probe.py --only replay
    python tools/ds_probe.py --only anthropic
    python tools/ds_probe.py --only stream
    python tools/ds_probe.py --only cache
"""

import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request

PREFS = os.path.join(
    os.environ.get("APPDATA", ""), "com.writerd", "writerD", "shared_preferences.json"
)
OPENAI_BASE = "https://api.deepseek.com"
ANTHROPIC_BASE = "https://api.deepseek.com/anthropic"
DEFAULT_MODEL = "deepseek-flash"

SK_RE = re.compile(r"sk-[A-Za-z0-9_\-]{4,}")


def redact(text):
    """任何输出都要过这一层：把可能的 Key 片段抹掉。"""
    if text is None:
        return ""
    return SK_RE.sub("sk-***", str(text))


def load_key():
    if not os.path.exists(PREFS):
        sys.exit("prefs not found: " + PREFS)
    with open(PREFS, "r", encoding="utf-8") as fh:
        raw = json.load(fh)
    key = ""
    for k, v in raw.items():
        if k.endswith("api_key") and isinstance(v, str) and v.strip():
            key = v.strip()
    if not key:
        sys.exit("no api_key in prefs")
    # 只报告形状，不报告内容
    print(json.dumps({"key_shape": {"len": len(key), "prefix": key[:3] + "***"}}))
    return key


def post(url, key, body, anthropic=False, timeout=180, raw=False):
    data = json.dumps(body).encode("utf-8")
    headers = {"content-type": "application/json", "authorization": "Bearer " + key}
    if anthropic:
        headers = {
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        }
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=timeout) as resp:
            payload = resp.read()
            return resp.status, payload, dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers or {})
    except Exception as e:  # 网络层
        return -1, redact(repr(e)).encode("utf-8"), {}


def read_sse(payload, limit=200):
    """把 SSE 原始字节解成 (事件统计, 见证行) —— 用于确认 keep-alive / reasoning_content。"""
    text = payload.decode("utf-8", "replace")
    lines = text.split("\n")
    comments = [ln for ln in lines if ln.startswith(":")]
    names = re.findall(r"^event:\s*(\S+)", text, flags=re.M)
    counts = {}
    for n in names:
        counts[n] = counts.get(n, 0) + 1
    stats = {
        "lines": len(lines),
        "comment_lines": len(comments),
        "comment_sample": comments[0][:40] if comments else "",
        "has_reasoning_content": "reasoning_content" in text,
        "has_keep_alive": any("keep-alive" in c for c in comments),
        "event_counts": counts,
        "thinking_delta": counts.get("content_block_delta", 0) and text.count('"thinking_delta"'),
        "first_lines": [redact(ln)[:limit] for ln in lines[:4]],
        "finish_reasons": sorted(set(re.findall(r'"finish_reason":"([a-z_]+)"', text))),
        "stop_reasons": sorted(set(re.findall(r'"stop_reason":"([a-z_]+)"', text))),
    }
    usage = None
    for ln in lines:
        if not ln.startswith("data:"):
            continue
        raw = ln[5:].strip()
        if raw in ("", "[DONE]"):
            continue
        try:
            j = json.loads(raw)
        except Exception:
            continue
        if isinstance(j, dict) and isinstance(j.get("usage"), dict):
            usage = j["usage"]
    if usage is not None:
        stats["usage"] = usage
    return stats


def brief(status, payload, anth=False):
    """错误体给前 300 字符（已 redact），成功体只给事件统计。"""
    p = payload.decode("utf-8", "replace")
    if status != 200:
        return {"status": status, "err": redact(p)[:300]}
    if anth:
        return {"status": status, "sse": read_sse(payload)}
    if p.lstrip().startswith("data:") or p.lstrip().startswith(":"):
        return {"status": status, "sse": read_sse(payload)}
    try:
        j = json.loads(p)
        return {
            "status": status,
            "finish": (j.get("choices") or [{}])[0].get("finish_reason"),
            "usage": j.get("usage"),
            "has_reasoning": "reasoning_content" in json.dumps(j),
        }
    except Exception:
        return {"status": status, "body": redact(p)[:200]}


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "file_read",
            "description": "read a file",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    }
]

HIST_PLAIN = [
    {"role": "user", "content": "记住一个词：海鸥。"},
    {"role": "assistant", "content": "好，记住了。"},
    {"role": "user", "content": "再说一个词：灯塔。"},
    {"role": "assistant", "content": "好，灯塔也记住了。"},
]
HIST_WITH_REASONING = [
    {"role": "user", "content": "记住一个词：海鸥。"},
    {"role": "assistant", "content": "好，记住了。", "reasoning_content": "用户让我记一个词，直接答应即可。"},
    {"role": "user", "content": "再说一个词：灯塔。"},
    {"role": "assistant", "content": "好，灯塔也记住了。", "reasoning_content": "同上，简短回应。"},
]


def body_openai(model, msgs, tools=None, thinking=True, effort="low", max_tokens=32):
    b = {
        "model": model,
        "messages": msgs,
        "stream": True,
        "max_tokens": max_tokens,
        "stream_options": {"include_usage": True},
        "thinking": {"type": "enabled" if thinking else "disabled"},
    }
    if thinking:
        b["reasoning_effort"] = effort
    if tools:
        b["tools"] = tools
    return b


def run(test, status, payload, anth=False):
    out = {"test": test}
    out.update(brief(status, payload, anth))
    print(json.dumps(out, ensure_ascii=True))
    return out


def t_balance(key):
    url = OPENAI_BASE + "/user/balance"
    req = urllib.request.Request(url, headers={"authorization": "Bearer " + key})
    try:
        with urllib.request.urlopen(req, context=ssl.create_default_context(), timeout=30) as r:
            j = json.loads(r.read().decode("utf-8"))
        print(
            json.dumps(
                {
                    "test": "balance",
                    "status": 200,
                    "keys": sorted(j.keys()),
                    "is_available": j.get("is_available"),
                    "infos": [
                        sorted(x.keys()) for x in (j.get("balance_infos") or [])
                    ],
                    "currencies": [x.get("currency") for x in (j.get("balance_infos") or [])],
                },
                ensure_ascii=True,
            )
        )
    except urllib.error.HTTPError as e:
        print(json.dumps({"test": "balance", "status": e.code, "err": redact(e.read().decode("utf-8", "replace"))[:200]}))
    except Exception as e:
        print(json.dumps({"test": "balance", "status": -1, "err": redact(repr(e))}))


def t_replay(key, model):
    """KL-DF-02：带 tools 时历史轮缺 reasoning_content 会不会 400。"""
    a = body_openai(model, HIST_PLAIN + [{"role": "user", "content": "回一个字"}], tools=TOOLS, thinking=True)
    run("A_tools_hist_no_reasoning", *post(OPENAI_BASE + "/v1/chat/completions", key, a))
    b = body_openai(model, HIST_WITH_REASONING + [{"role": "user", "content": "回一个字"}], tools=TOOLS, thinking=True)
    run("B_tools_hist_with_reasoning", *post(OPENAI_BASE + "/v1/chat/completions", key, b))
    c = body_openai(model, HIST_PLAIN + [{"role": "user", "content": "回一个字"}], tools=None, thinking=True)
    run("C_no_tools_hist_no_reasoning", *post(OPENAI_BASE + "/v1/chat/completions", key, c))
    d = body_openai(model, HIST_PLAIN + [{"role": "user", "content": "回一个字"}], tools=TOOLS, thinking=False)
    run("E_tools_thinking_disabled", *post(OPENAI_BASE + "/v1/chat/completions", key, d))


def t_anthropic(key, model):
    """KL-DF-05：Anthropic 格式思考字段形状。"""
    def anth(extra):
        b = {
            "model": model,
            "messages": [{"role": "user", "content": [{"type": "text", "text": "回一个字"}]}],
            "stream": True,
            "max_tokens": 256,
        }
        b.update(extra)
        return b

    run(
        "D1_anth_reasoning_effort_only",
        *post(ANTHROPIC_BASE + "/v1/messages", key, anth({"reasoning": {"effort": "low"}}), anthropic=True),
    )
    run(
        "D2_anth_reasoning_plus_output_config",
        *post(
            ANTHROPIC_BASE + "/v1/messages",
            key,
            anth({"reasoning": {"effort": "low"}, "output_config": {"effort": "low"}}),
            anthropic=True,
        ),
    )
    run(
        "D3_anth_output_config_only",
        *post(ANTHROPIC_BASE + "/v1/messages", key, anth({"output_config": {"effort": "low"}}), anthropic=True),
    )
    run(
        "D4_anth_reasoning_none",
        *post(ANTHROPIC_BASE + "/v1/messages", key, anth({"reasoning": {"effort": "none"}}), anthropic=True),
    )


def t_stream(key, model):
    """KL-DF-01：真实流里是否出现 `: keep-alive` 注释行；顺带看 reasoning_content。"""
    b = body_openai(
        model,
        [{"role": "user", "content": "用一句话解释为什么天空是蓝色的。"}],
        tools=None,
        thinking=True,
        effort="max",
        max_tokens=64,
    )
    run("F_stream_shape", *post(OPENAI_BASE + "/v1/chat/completions", key, b))


def t_cache(key, model):
    """KL-DF-04：同一长前缀连发两次，看 prompt_cache_hit_tokens 是否第二次命中。"""
    filler = "海鸥飞过灯塔，潮水退去，礁石上留下盐的白。 " * 120  # 约 1.5K 汉字前缀
    msgs = [{"role": "user", "content": filler + "\n回一个字。"}]
    for i in (1, 2, 3):
        b = body_openai(model, msgs, tools=None, thinking=False, max_tokens=16)
        run("G_cache_run%d" % i, *post(OPENAI_BASE + "/v1/chat/completions", key, b))
        time.sleep(1)


def t_limits(key, model):
    """KL-DF-09/D-024：max_tokens=384000 是否被接受（只要一个字，花费极小）。"""
    b = body_openai(model, [{"role": "user", "content": "只回一个字：好"}], tools=None, thinking=False, max_tokens=384000)
    b["max_tokens"] = 384000
    run("H_max_tokens_384k", *post(OPENAI_BASE + "/v1/chat/completions", key, b))


def t_anth2(key, model):
    """KL-DF-05 第二轮：Anthropic 格式的**开关**到底由哪个字段决定（D4 证明 reasoning.effort=none 关不掉）。"""
    hard = "一个三位数，各位数字之和是 15，十位比个位大 3，百位是十位的一半。这个数是多少？先推理再给答案。"

    def anth(extra):
        b = {
            "model": model,
            "messages": [{"role": "user", "content": [{"type": "text", "text": hard}]}],
            "stream": True,
            "max_tokens": 900,
        }
        b.update(extra)
        return b

    run("P0_anth_no_thinking_fields", *post(ANTHROPIC_BASE + "/v1/messages", key, anth({}), anthropic=True))
    run(
        "P1_anth_thinking_disabled",
        *post(ANTHROPIC_BASE + "/v1/messages", key, anth({"thinking": {"type": "disabled"}}), anthropic=True),
    )
    run(
        "P2_anth_thinking_enabled_oc_low",
        *post(
            ANTHROPIC_BASE + "/v1/messages",
            key,
            anth({"thinking": {"type": "enabled"}, "output_config": {"effort": "low"}}),
            anthropic=True,
        ),
    )
    run(
        "P3_anth_thinking_enabled_oc_max",
        *post(
            ANTHROPIC_BASE + "/v1/messages",
            key,
            anth({"thinking": {"type": "enabled"}, "output_config": {"effort": "max"}}),
            anthropic=True,
        ),
    )
    run(
        "P4_anth_reasoning_low",
        *post(ANTHROPIC_BASE + "/v1/messages", key, anth({"reasoning": {"effort": "low"}}), anthropic=True),
    )
    run(
        "P5_anth_reasoning_max",
        *post(ANTHROPIC_BASE + "/v1/messages", key, anth({"reasoning": {"effort": "max"}}), anthropic=True),
    )


def t_openai2(key, model):
    """OpenAI 格式的档位是否真有区分度（附录 A §2：真正有区分度的只有 low/high/max）。"""
    hard = "一个三位数，各位数字之和是 15，十位比个位大 3，百位是十位的一半。这个数是多少？先推理再给答案。"
    for lvl in ("low", "high", "max"):
        b = {
            "model": model,
            "messages": [{"role": "user", "content": hard}],
            "stream": True,
            "max_tokens": 900,
            "thinking": {"type": "enabled"},
            "reasoning_effort": lvl,
        }
        run("O_effort_%s" % lvl, *post(OPENAI_BASE + "/v1/chat/completions", key, b))


def t_effort2(key, model):
    """档位区分度：简单题 + 充裕上限，看 reasoning_tokens 是否随 low/high/max 变化。"""
    easy = "1+1 等于几？直接给答案。"
    for lvl in ("low", "high", "max"):
        b = {
            "model": model,
            "messages": [{"role": "user", "content": easy}],
            "stream": True,
            "max_tokens": 3000,
            "thinking": {"type": "enabled"},
            "reasoning_effort": lvl,
        }
        run("E2_%s" % lvl, *post(OPENAI_BASE + "/v1/chat/completions", key, b))


def t_keepalive(key, model):
    """KL-DF-01：大前缀（冷缓存）下 prefill 期间的等待，是否出现 `: keep-alive` 注释行。"""
    filler = "海鸥飞过灯塔，潮水退去，礁石上留下盐的白。 " * 2000  # 约 2.5 万 token 前缀
    b = {
        "model": model,
        "messages": [{"role": "user", "content": filler + "\n只回一个字：好"}],
        "stream": True,
        "max_tokens": 8,
        "thinking": {"type": "disabled"},
    }
    run("K_keepalive_long_prefill", *post(OPENAI_BASE + "/v1/chat/completions", key, b, timeout=600))


def main():
    ap = argparse.ArgumentParser()
    # B12-8: validate --only. A typo ("balanc") used to run nothing at all and still
    # exit 0 -- while this probe's output is cited as `[已实测]` evidence in
    # docs/DECISIONS.md. argparse exits 2 on an unknown choice.
    ap.add_argument(
        "--only",
        default="all",
        choices=["all", "balance", "replay", "anthropic", "anth2", "openai2", "effort2",
                 "keepalive", "stream", "cache", "limits"],
        help="balance|replay|anthropic|anth2|openai2|effort2|keepalive|stream|cache|limits|all",
    )
    ap.add_argument("--model", default=DEFAULT_MODEL)
    args = ap.parse_args()
    key = load_key()
    which = args.only
    if which in ("all", "balance"):
        t_balance(key)
    if which in ("all", "replay"):
        t_replay(key, args.model)
    if which in ("all", "anthropic"):
        t_anthropic(key, args.model)
    if which in ("all", "anth2"):
        t_anth2(key, args.model)
    if which in ("all", "openai2"):
        t_openai2(key, args.model)
    if which in ("all", "effort2"):
        t_effort2(key, args.model)
    if which in ("all", "keepalive"):
        t_keepalive(key, args.model)
    if which in ("all", "stream"):
        t_stream(key, args.model)
    if which in ("all", "cache"):
        t_cache(key, args.model)
    if which in ("all", "limits"):
        t_limits(key, args.model)


if __name__ == "__main__":
    main()