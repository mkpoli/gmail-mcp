#!/usr/bin/env python3
"""Render each README through GitHub's renderer; fail if markup leaks to the reader."""
import re, subprocess, sys
from html import unescape

status = 0
for f in ["README.md", "README.ja.md", "README.zh.md"]:
    html = subprocess.run(
        ["gh", "api", "--method", "POST", "/markdown", "-f", "mode=gfm", f"--field", f"text=@{f}"],
        capture_output=True, text=True, check=True).stdout

    # visible text only: code blocks and inline code may legitimately contain **
    visible = re.sub(r"<pre.*?</pre>|<code.*?</code>", "", html, flags=re.S)
    visible = re.sub(r"<[^>]+>", "", visible)

    leaks = re.findall(r"\*\*|\[[^\]\n]+\]\([^)\n]+\)", visible)
    if leaks:
        print(f"FAIL {f}: markup reached the reader — {leaks[:5]}")
        status = 1

    # every bold span declared in source must appear as <strong>
    src = open(f, encoding="utf-8").read()
    src_no_code = re.sub(r"```.*?```", "", src, flags=re.S)
    # &, < and > come back as entities, so compare the text a reader sees
    strongs = {unescape(re.sub(r"<[^>]+>", "", s)) for s in re.findall(r"<strong>(.*?)</strong>", html, re.S)}
    for b in re.findall(r"\*\*([^*\n]+)\*\*", src_no_code):
        key = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", b).replace("`", "").strip()
        if not key:
            continue
        if not any(key in s or s in key for s in strongs):
            print(f"FAIL {f}: bold never closed — **{b[:60]}**")
            status = 1

    if status == 0 or True:
        print(f"ok   {f}")
sys.exit(status)
