import json

import pytest

from tokeneconomizer.loopguard.turn import TurnGuard
from tokeneconomizer.loopguard.rules import scaled_thresholds
from test_guard_ts import node_guard


def test_turn_guard_parity(monkeypatch):
    monkeypatch.setattr("tokeneconomizer.loopguard.turn.time.time", lambda: 1000.0)
    thr = scaled_thresholds()
    thr.update(min_turns=2, edit_churn=1, error_outputs=1, stagnation=0, gate_min_turns=1,
               gate_error_outputs=1, backstop_turns=100)
    edit = ["Edit", {"path": "/src/a.py"}, "ok", 0]
    fail = ["Bash", {"command": "pytest"}, "FAILED a.py: AssertionError", 1]
    cases = [
        {"name": "cold", "calls": [edit, fail], "envelope": None},
        {"name": "ladder", "calls": [edit, fail, edit, fail], "envelope": 2, "thr": thr, "reset": True},
        {"name": "backstop", "calls": [edit, fail, edit, fail], "envelope": 1,
         "thr": {**thr, "backstop_turns": 2}, "reset": True},
        {"name": "reverts", "calls": [["Bash", {"command": "git restore /src/a.py"}, "", 0],
                 ["Bash", {"command": "sed -i 's/a/b/' /src/a.py && pytest"}, "1 passed in 1s", 0],
                 ["Bash", {"command": "git restore /src/a.py"}, "", 0]]},
        {"name": "status", "calls": [edit, ["Bash", {"command": "pytest | tail"}, "1 failed in 1s", 0],
                 ["Bash", {"command": "pytest; git diff"}, "1 passed in 1s", 1],
                 ["Bash", {"command": "pytest | tail"}, "ValueError: x", 0]]},
        {"name": "productive_outputs", "calls": [
            ["Read", {"path": "/src/a.py"}, "assert False\nValueError", None],
            ["Bash", {"command": "cat /src/a.py"}, "ValueError", 0],
            ["Edit", {"path": "/src/a.py"}, "assert failed", 0],
            ["Bash", {"command": "npx vitest run"}, " Tests  3 passed (3)", 0]]},
        {"name": "ambiguous_nudge", "calls": [edit, fail], "envelope": 20,
         "thr": {**thr, "nudge_on_ambiguous": True}, "judge": {"stuck": None}},
        {"name": "held", "calls": [edit, fail], "envelope": 1, "thr": thr, "held": ["nudge", "held"]},
        *[{"name": name, "calls": [edit, fail, fail, fail], "envelope": 20, "thr": thr, "judge": verdict}
          for name, verdict in [("stuck", {"stuck": True, "confidence": 0.9, "reason": "loop", "_tokens": 3}),
                                ("productive", {"stuck": False, "_tokens": 2}),
                                ("ambiguous", {"stuck": None}), ("throttled", None)]],
        {"name": "background", "calls": [edit, fail, fail], "envelope": 20, "thr": thr,
         "background": {"stuck": True, "confidence": 0.9, "reason": "async", "_nudge": " redirect "}},
        {"name": "no_verdict", "calls": [edit, fail, fail], "envelope": 20, "thr": thr, "background": None},
        {"name": "writer", "calls": [edit], "writer": {"text": "  hello  ", "_tokens": 4}},
        {"name": "writer_empty", "calls": [edit], "writer": {"text": " ", "_tokens": 4}},
    ]

    def python_case(case):
        g = TurnGuard(case["name"])
        g.held = case.get("held")
        outputs, digests = [], []
        if "background" in case:
            class Background:
                def start(self, guard, digest):
                    digests.append(digest)
                    return "job"

                def poll(self, guard):
                    return (True, case["background"]) if guard.judge_pending and case["background"] else (False, None)
            judge = Background()
        elif "judge" in case:
            def judge(digest):
                digests.append(digest)
                return case["judge"]
        else:
            judge = None
        for call in case["calls"]:
            decision = g.fold(*call, envelope=case.get("envelope"), thr=case.get("thr"), judge=judge)
            outputs.append(list(decision) if decision else None)
            if decision and decision[0] == "nudge" and case.get("reset"):
                g.after_nudge()
        body = g.nudge_body(case.get("envelope"), (lambda _: case["writer"]) if "writer" in case else None)
        d = g.to_dict()
        return {"decisions": outputs, "state": d, "summary": g.summary(), "not_normal": g.resolved_proxy(False),
                "verification": g.verification_state(), "body": body, "digests": digests,
                "restored": TurnGuard(data=d).to_dict()}

    expected = [python_case(case) for case in cases]
    script = f'''const {{ pathToFileURL }} = await import("node:url");
const {{ TurnGuard }} = await import(new URL("turn.ts", pathToFileURL(process.argv[1])));
Date.now = () => 1000000;
const cases = {json.dumps(cases)};
const result = cases.map(c => {{
  const g = new TurnGuard(c.name), outputs = [], digests = [];
  g.held = c.held || null;
  let judge = null;
  if (Object.hasOwn(c, "background")) judge = {{
    start(guard, digest) {{ digests.push(digest); return "job"; }},
    poll(guard) {{ return guard.judge_pending && c.background ? [true, c.background] : [false, null]; }}
  }};
  else if (Object.hasOwn(c, "judge")) judge = digest => {{ digests.push(digest); return c.judge; }};
  for (const call of c.calls) {{
    const decision = g.fold(...call, {{envelope: c.envelope ?? null, thr: c.thr ?? null, judge}});
    outputs.push(decision);
    if (decision && decision[0] === "nudge" && c.reset) g.after_nudge();
  }}
  const body = g.nudge_body(c.envelope ?? null, Object.hasOwn(c, "writer") ? () => c.writer : null);
  const d = g.to_dict();
  return {{ decisions: outputs, state: d, summary: g.summary(), not_normal: g.resolved_proxy(false),
    verification: g.verification_state(), body, digests, restored: new TurnGuard("", d).to_dict() }};
}});
console.log(JSON.stringify(result));'''
    assert node_guard(script) == expected


def test_turn_guard_background_stale_and_backoff(monkeypatch):
    monkeypatch.setattr("tokeneconomizer.loopguard.turn.time.time", lambda: 1000.0)
    g = TurnGuard("stale")
    g.st.turns = 10
    g.judge_pending = {"id": "old", "since": 699, "segment": 0}
    class Judge:
        def poll(self, guard): return False, None
        def start(self, guard, digest): return "new"
    call = g._background(Judge())
    values = [call("digest"), call("digest")]
    g._backoff({"stuck": False})
    g._backoff({"stuck": False})
    expected = {"values": values, "pending": g.judge_pending, "calls": g.judge_calls, "gap": g.judge_gap}
    script = '''const { pathToFileURL } = await import("node:url");
const { TurnGuard } = await import(new URL("turn.ts", pathToFileURL(process.argv[1])));
Date.now = () => 1000000;
const g = new TurnGuard("stale"); g.st.turns = 10;
g.judge_pending = {id:"old", since:699, segment:0};
const call = g._background({poll: () => [false, null], start: () => "new"});
const values = [call("digest"), call("digest")];
g._backoff({stuck:false}); g._backoff({stuck:false});
console.log(JSON.stringify({values, pending:g.judge_pending, calls:g.judge_calls, gap:g.judge_gap}));'''
    assert node_guard(script) == expected
