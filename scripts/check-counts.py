#!/usr/bin/env python3
"""Fails when a README advertises a different number of tools or tests than the
source actually has. Both numbers appear in every language, so a change to
either drifts silently across nine places otherwise."""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
READMES = ["README.md", "README.ja.md", "README.zh.md"]

# Patterns whose single capture group is a count claimed about this project.
# Third-party columns of the comparison table are deliberately not matched.
TEST_CLAIMS = [
    r"tests-(\d+)_passing",
    r"(\d+) unit tests",
    r"(\d+)件の単体テスト",
    r"単体テスト(\d+)件",
    r"(\d+)个单元测试",
]
TOOL_CLAIMS = [r"badge/tools-(\d+)-"]


def actual_tools() -> int:
    source = (ROOT / "src" / "index.ts").read_text(encoding="utf-8")
    return len(re.findall(r"this\.server\.tool\(", source))


def actual_tests() -> int:
    proc = subprocess.run(
        ["bun", "test"], cwd=ROOT, capture_output=True, text=True, check=False
    )
    output = proc.stdout + proc.stderr
    match = re.search(r"Ran (\d+) tests", output)
    if not match:
        sys.exit("could not read a test count from 'bun test'")
    return int(match.group(1))


def check(label: str, expected: int, patterns: list[str]) -> list[str]:
    problems = []
    for name in READMES:
        text = (ROOT / name).read_text(encoding="utf-8")
        for pattern in patterns:
            for claimed in re.findall(pattern, text):
                if int(claimed) != expected:
                    problems.append(
                        f"{name}: claims {claimed} {label}, source has {expected}"
                        f"  (pattern {pattern!r})"
                    )
    return problems


def main() -> int:
    problems = check("tools", actual_tools(), TOOL_CLAIMS)
    problems += check("tests", actual_tests(), TEST_CLAIMS)
    for problem in problems:
        print(f"FAIL {problem}")
    if problems:
        return 1
    print("ok   tool and test counts match the source")
    return 0


if __name__ == "__main__":
    sys.exit(main())
