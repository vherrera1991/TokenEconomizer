import ast
import json
from pathlib import Path

from tokeneconomizer.loopguard.shell_edits import _split_heredocs, shell_edit_targets, shell_revert_targets
from tokeneconomizer.loopguard.state import SpiralState
from tokeneconomizer.loopguard.turn import exit_status_covers, runner_verdict, status_of_tests

from test_guard_ts import node_guard


ROOT = Path(__file__).resolve().parents[1]


def parameters(path, names):
    tree = ast.parse((ROOT / path).read_text())
    found = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in names:
            for decorator in node.decorator_list:
                if isinstance(decorator, ast.Call) and len(decorator.args) >= 2:
                    found.extend(ast.literal_eval(decorator.args[1]))
    return found


def run(script):
    prefix = '''const { pathToFileURL } = await import("node:url");
const state = await import(pathToFileURL(process.argv[1]).href);
const shell = await import(new URL("shell_edits.ts", pathToFileURL(process.argv[1])));
const status = await import(new URL("status.ts", pathToFileURL(process.argv[1])));
'''
    return node_guard(prefix + script)


def test_shell_edit_parity():
    examples = parameters("tests/test_live_core.py", {"test_edits_made_through_the_shell_are_recognised"})
    cmds = [cmd for cmd, _ in examples] + [
        "git checkout -q -- apps/web/AGENTS.md", "git restore apps/web/page.tsx",
        "python -c \"open('src/a.py','w').write('x')\"", "python -c \"open(name,'w')\"",
        "apply_patch <<'EOF'\n*** Update File: src/a.py\nEOF", "cat > /tmp/x.py << EOF\nfoo\nEOF",
        "sed -i 'unfinished\nsed -i 's/a/b/' good.py", "python -c 'print(2)'",
    ]
    st = SpiralState()
    st.update("Bash", {"command": "echo x"}, "")
    script = f'''const cmds = {json.dumps(cmds)};
const st = new state.SpiralState(); st.update("Bash", {{command: "echo x"}}, "");
shell.fold_shell_edits(st, ["a.py", "b.py", "c.py", "d.py", "e.py"]);
console.log(JSON.stringify({{edits: cmds.map(shell.shell_edit_targets), reverts: cmds.map(shell.shell_revert_targets),
heredocs: cmds.map(shell._split_heredocs), fold: [st.edit_counts, st.edit_order, st.recent]}}));'''
    from tokeneconomizer.loopguard.shell_edits import fold_shell_edits
    fold_shell_edits(st, ["a.py", "b.py", "c.py", "d.py", "e.py"])
    assert run(script) == {"edits": [shell_edit_targets(c) for c in cmds],
                           "reverts": [shell_revert_targets(c) for c in cmds],
                           "heredocs": [list(_split_heredocs(c)) for c in cmds],
                           "fold": [st.edit_counts, st.edit_order, st.recent]}


def test_shell_status_parity():
    cmds = [x[0] for x in parameters("tests/test_loopguard_productive_turns.py", {
        "test_an_exit_status_covers_a_command_unless_its_work_could_fail_unseen"})]
    names = {"test_a_runner_started_by_a_launcher_counts_as_a_verification",
             "test_a_runner_behind_env_or_nice_options_counts_as_a_verification",
             "test_env_and_nice_leave_what_they_run_to_decide",
             "test_a_runner_behind_pythons_own_options_counts_as_a_verification",
             "test_pythons_own_options_leave_what_it_runs_to_decide",
             "test_a_ruby_test_run_counts_as_a_verification",
             "test_ruby_that_runs_no_test_file_is_not_a_verification",
             "test_a_launcher_leaves_what_it_runs_to_decide",
             "test_a_non_test_command_mentioning_a_runner_is_not_a_verification"}
    cmds += [x[0] if isinstance(x, tuple) else x for x in parameters("tests/test_live_core.py", names)]
    cmds += ["dotenv -e .env.local -- npx vitest run a.test.ts", "pytest || true", "pytest; git diff",
             "bash -lc 'pytest | tail -3'", "cat <<EOF > ci.sh\nnpm test\nEOF", "pytest -q && npm test",
             "set -o pipefail; pytest | tail", "grep -rn Error src | head", "find src -delete; pytest"]
    texts = ["", "  1 failed\n  6 passed (20.1s)", "Assertion failed: libuv\n  7 passed (23.6s)",
             "FAILED (failures=1)", "# fail 2", "# fail 0", "--- FAIL: Test", "fail\tpkg",
             "8 runs, 9 assertions, 1 failures, 0 errors, 0 skips", "8 runs, 9 assertions, 0 failures, 0 errors, 0 skips",
             "Tests: 3 passed", "Tests  1 failed", "2 failed in 1.2s", "BUILD SUCCESS", "BUILD FAILURE"]
    script = f'''const cmds = {json.dumps(cmds)}, texts = {json.dumps(texts)};
console.log(JSON.stringify({{covers: cmds.map(status.exit_status_covers),
statuses: cmds.map(status.status_of_tests), verdicts: texts.map(status.runner_verdict)}}));'''
    assert run(script) == {"covers": [exit_status_covers(c) for c in cmds],
                           "statuses": [status_of_tests(c) for c in cmds],
                           "verdicts": [runner_verdict(t) for t in texts]}
