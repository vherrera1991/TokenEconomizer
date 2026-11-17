import json

from test_guard_ts import ROOT, node_guard


def test_guard_runtime_paths_and_judge(tmp_path):
    script = '''
const { pathToFileURL } = await import("node:url");
const fs = await import("node:fs");
const path = await import("node:path");
const assert = (await import("node:assert/strict")).default;
const session = await import(pathToFileURL(SESSION));
const { AsyncJudge } = await import(pathToFileURL(JUDGE));
const root = ROOT, sid = "session:1", key = "repo-key";
assert.equal(session.safeSid("a/b:é"), "a_b__");
assert.equal(session.safeSid("x".repeat(210)).length, 200);
assert.equal(session.resolvePaths(root, sid), null);
const pin = path.join(root, "sessions/pi/session_1.json");
assert.ok(session.writeJson(pin, {key}));
const paths = session.resolvePaths(root, sid);
const host = path.join(root, "repos", key, "pi");
assert.deepEqual(paths, {pin, host, session: path.join(host, "sessions", `${sid}.json`),
  judgeRequest: path.join(host, "judge", `${sid}.request.json`),
  judgeResult: path.join(host, "judge", `${sid}.result.json`),
  repomap: path.join(root, "repos", key, "repomap.json")});
assert.equal(session.sessionPath(root, key, sid), paths.session);
assert.equal(session.readSession(paths), null);
assert.equal(session.patchSession(paths, {turn: {}}), false);
assert.ok(session.writeJson(paths.session, {session_id: sid, injected_text: "keep", turns: 5, turn: null}));
assert.ok(session.patchSession(paths, {turn: {segment: 2}, nudges: 1, aborts: 0, updated: 12,
  repomap_done: true, repomap_chars: 42, injected_text: "overwrite"}));
assert.deepEqual(session.readSession(paths), {session_id: sid, injected_text: "keep", turns: 5,
  turn: {segment: 2}, nudges: 1, aborts: 0, updated: 12, repomap_done: true, repomap_chars: 42});
assert.deepEqual(fs.readdirSync(path.dirname(paths.session)), [`${sid}.json`]);
const env = {TOKENECONOMIZER_HOME: root, PATH: "/bin"}, cwd = "/work";
let call;
const judge = new AsyncJudge(paths, sid, 0.7, cwd, env, (...args) => { call = args; });
const guard = {turn_key: "turn:1", segment: 2, judge_calls: 3, judge_pending: null};
assert.deepEqual(judge.poll(guard), [false, null]);
const id = judge.start(guard, "digest");
assert.match(id, /^turn:1:2:3:\\d+\\.\\d{3}$/);
const request = session.readJson(paths.judgeRequest);
assert.deepEqual({...request, at: 0}, {id, session_id: sid, turn_key: "turn:1", segment: 2,
  digest: "digest", threshold: 0.7, at: 0});
assert.equal(typeof request.at, "number");
assert.deepEqual(call, ["te", ["--host", "pi", "--cwd", cwd, "judge", "--session", sid, "--job", id], env, cwd]);
guard.judge_pending = {id, since: request.at, segment: 2};
assert.deepEqual(judge.poll(guard), [false, null]);
session.writeJson(paths.judgeResult, {id: "stale", verdict: {stuck: true}});
assert.deepEqual(judge.poll(guard), [false, null]);
fs.writeFileSync(paths.judgeResult, "{");
assert.deepEqual(judge.poll(guard), [false, null]);
const verdict = {stuck: true, confidence: 0.9, _nudge: "change approach"};
session.writeJson(paths.judgeResult, {id, verdict, at: 1});
assert.deepEqual(judge.poll(guard), [true, verdict]);
session.writeJson(paths.judgeResult, {id, verdict: null});
assert.deepEqual(judge.poll(guard), [true, null]);
fs.writeFileSync(paths.session, "bad json");
assert.equal(session.patchSession(paths, {turn: {}}), false);
console.log(JSON.stringify(true));
'''.replace("SESSION", json.dumps(str(ROOT / "plugin/pi/guard/session.ts"))).replace(
        "JUDGE", json.dumps(str(ROOT / "plugin/pi/guard/judge.ts"))).replace("ROOT", json.dumps(str(tmp_path)))
    assert node_guard(script) is True
