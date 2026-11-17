import json
import shutil
import subprocess
from pathlib import Path

import pytest

from tokeneconomizer.loopguard.rules import assess_abort, gate_for_judge, is_stuck, nudge_text, scaled_thresholds
from tokeneconomizer.loopguard.state import ERR_RE, TEST_RUN_RE, SpiralState, _failure_sig, canon_tool


ROOT = Path(__file__).resolve().parents[1]


def node_guard(script):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    run = subprocess.run([node, "--experimental-strip-types", "--no-warnings", "--input-type=module",
                          "-e", script, str(ROOT / "plugin/pi/guard/state.ts"),
                          str(ROOT / "plugin/pi/guard/rules.ts")],
                         capture_output=True, text=True, timeout=60)
    if run.returncode and "strip-types" in run.stderr:
        pytest.skip("this node cannot load TypeScript")
    assert run.returncode == 0, run.stderr
    return json.loads(run.stdout)


def test_guard_ts_state_matches_python():
    calls = [
        ["Edit", {"file_path": "C:\\repo\\a.py"}, "assert failed", False],
        ["Bash", {"command": "pytest -q"}, "FAILED /tmp/a.py:12 AssertionError: 1", True],
        ["Bash", {"command": "pytest -q"}, "FAILED /tmp/b.py:99 AssertionError: 2", True],
        ["Bash", {"command": "pytest -q"}, "1 passed", False],
        ["Read", {"file_path": "/r/test.py"}, "assert False\nValueError", None],
        ["Grep", {"pattern": "assert"}, "assert False", None],
        ["Write", {"path": "/r/test.py"}, "assert failed", False],
        ["Read", {"path": "/r/missing"}, "Error: missing", True],
        ["apply_patch", {"paths": ["/a/a.py", "/b/a.py", "/b/b.py"]}, "ok", False],
    ]
    regex_cases = ["--- FAIL: Test", "--- fail: Test", "FAIL\tpkg", "fail\tpkg", "FAIL", "fail",
                   "FAIL: test_x", "# fail 2", "# FAIL 2", "not ok 3", "3 FAILURES", "assert x", "assertion",
                   "ValueError", "valueerror", "failed"]
    commands = ["pytest -q", "Py.Test", "python3 -c 'x'", "python3 -m unittest", "python -m unittest", "vitest"]
    names = ["Bash", "shell", "Read", "Edit", "MultiEdit", "Write", "Grep", "Glob", "Unknown", ""]
    state = SpiralState()
    for call in calls:
        state.update(*call)
    script = f'''const {{ pathToFileURL }} = await import("node:url");
const s = await import(pathToFileURL(process.argv[1]).href);
const state = new s.SpiralState();
for (const c of {json.dumps(calls)}) state.update(...c);
console.log(JSON.stringify({{snapshot: state.snapshot(), digest: state.recent_digest(24, 8), counts: state.edit_counts,
order: state.edit_order, sigs: state.fail_sigs, recent: state.recent,
canon: {json.dumps(names)}.map(s.canon_tool), errors: {json.dumps(regex_cases)}.map(x => s.ERR_RE.test(x)),
tests: {json.dumps(commands)}.map(x => s.TEST_RUN_RE.test(x)),
signatures: {json.dumps(regex_cases)}.map(s.failure_sig)}}));'''
    assert node_guard(script) == {
        "snapshot": state.snapshot(), "digest": state.recent_digest(envelope=8), "counts": state.edit_counts,
        "order": state.edit_order, "sigs": state.fail_sigs, "recent": state.recent,
        "canon": [canon_tool(n) for n in names], "errors": [bool(ERR_RE.search(s)) for s in regex_cases],
        "tests": [bool(TEST_RUN_RE.search(s)) for s in commands],
        "signatures": [_failure_sig(s) for s in regex_cases],
    }


def test_guard_ts_regex_unicode_boundaries():
    script = '''const { pathToFileURL } = await import("node:url");
const s = await import(pathToFileURL(process.argv[1]).href);
console.log(JSON.stringify([s.ERR_RE.test("éFAILEDé"), s.TEST_RUN_RE.test("pytesté")]));'''
    assert [bool(ERR_RE.search("éFAILEDé")), bool(TEST_RUN_RE.search("pytesté"))] == [False, False]
    assert node_guard(script) == [False, False]


def test_guard_ts_rules_match_python():
    state = SpiralState()
    calls = []
    for _ in range(12):
        calls.extend([["Edit", {"path": "/r/a.py"}, "ok", False],
                      ["Bash", {"command": "pytest"}, "FAILED x: AssertionError", True]])
    for call in calls:
        state.update(*call)
    thr = scaled_thresholds("aggressive")
    thr.update(backstop_turns=50, gate_over_envelope=False)
    verdicts = [{"stuck": True, "confidence": 0.9, "reason": "same failure"},
                {"stuck": False}, {"stuck": None}, None]
    script = f'''const {{ pathToFileURL }} = await import("node:url");
const s = await import(pathToFileURL(process.argv[1]).href);
const r = await import(pathToFileURL(process.argv[2]).href);
const state = new s.SpiralState();
for (const c of {json.dumps(calls)}) state.update(...c);
const thr = {{...r.scaled_thresholds("aggressive"), backstop_turns: 50, gate_over_envelope: false}};
const vs = {json.dumps(verdicts)};
console.log(JSON.stringify({{levels: ["default", "aggressive", "conservative", "unknown"].map(r.scaled_thresholds),
gate: r.gate_for_judge(state, thr), stuck: r.is_stuck(state, thr),
fallback: [r.assess_abort(state, 20, null, thr), r.assess_abort(state, 30, null, thr), r.assess_abort(state, 9, null, {{...thr, backstop_turns: 20}})],
judges: vs.map(v => r.assess_abort(state, 20, () => v, thr)),
closed: r.assess_abort(new s.SpiralState(), 20, () => vs[0], thr),
thrown: r.assess_abort(state, 20, () => {{ throw Error(); }}, thr), nudge: r.nudge_text(state)}}));'''
    assert node_guard(script) == {
        "levels": [scaled_thresholds(x) for x in ("default", "aggressive", "conservative", "unknown")],
        "gate": gate_for_judge(state, thr), "stuck": is_stuck(state, thr),
        "fallback": [list(assess_abort(state, 20, thr=thr)), list(assess_abort(state, 30, thr=thr)),
                     list(assess_abort(state, 9, thr={**thr, "backstop_turns": 20}))],
        "judges": [list(assess_abort(state, 20, lambda _, v=v: v, thr)) for v in verdicts],
        "closed": list(assess_abort(SpiralState(), 20, lambda _: verdicts[0], thr)),
        "thrown": [False, "judge-throttled"], "nudge": nudge_text(state),
    }
