import json

from test_guard_ts import ROOT, node_guard


def test_pi_native_guard_persists_and_stops(tmp_path):
    script = '''
const { pathToFileURL } = await import("node:url");
const fs = await import("node:fs");
const assert = (await import("node:assert/strict")).default;
const { default: extension } = await import(pathToFileURL(EXT));
const { resolvePaths, readSession } = await import(pathToFileURL(SESSION));
process.env.TOKENECONOMIZER_HOME = ROOT;
process.env.TE_LOOPGUARD = "nudge";
process.env.TE_TOOLPRUNE = "off";
process.env.TE_MICROSKILLS = "off";
const handlers = {};
const pi = {on: (name, handler) => handlers[name] = handler, registerCommand: () => {},
  sendMessage: () => {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {}};
extension(pi);
const ctx = {cwd: ROOT, mode: "print", sessionManager: {getSessionId: () => "native-session",
  getSessionFile: () => "", getBranch: () => []}};
await handlers.session_start({reason: "startup"}, ctx);
const paths = resolvePaths(ROOT, "native-session");
assert.ok(paths);
await handlers.before_agent_start({prompt: "hello"}, ctx);
assert.equal(readSession(paths).turn.turn_key, "native-session:1");
await Promise.all([handlers.tool_result({toolName: "read", input: {path: "a"}, content: [{type: "text", text: "ok"}]}, ctx),
  handlers.tool_result({toolName: "read", input: {path: "b"}, content: [{type: "text", text: "ok"}]}, ctx)]);
assert.equal(readSession(paths).turn.cum_turns, 2);
await handlers.agent_end({willContinue: true}, ctx);
await handlers.tool_result({toolName: "read", input: {}, content: []}, ctx);
assert.equal(readSession(paths).turn.cum_turns, 3);
await handlers.agent_end({willContinue: false}, ctx);
await handlers.session_shutdown({reason: "shutdown"}, ctx);
assert.ok(readSession(paths).ended);
console.log(JSON.stringify(true));
'''.replace("EXT", json.dumps(str(ROOT / "plugin/pi/tokeneconomizer.ts"))).replace(
        "SESSION", json.dumps(str(ROOT / "plugin/pi/guard/session.ts"))).replace("ROOT", json.dumps(str(tmp_path)))
    assert node_guard(script) is True
