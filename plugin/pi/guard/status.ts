import { _split_heredocs } from "./shell_edits.ts";

// Expand case-insensitive text, leaving interpreter options case-sensitive.
function insensitive(pattern: string): string {
  let out = "", inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") { out += c + pattern[++i]; continue; }
    if (c === "[") inClass = true;
    if (c === "]") inClass = false;
    out += !inClass && /[A-Za-z]/.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c;
  }
  return out;
}
const python = insensitive(String.raw`python\d?(?:\.\d+)?`) + String.raw`(?:\s+(?:-[bBdEiIOPqsSuvx]+|-[WX]\s*[^\s\-]\S*))*`;
const ruby = insensitive("ruby") + String.raw`(?:\s+(?:-[Ir](?:\S+|\s+[^\s\-]\S*)|-C\s*\S+|-W[0-2]?(?::\S+)?|--[\w\-]+(?:=\S+)?|-[abdf-zABDF-Z]+))*\s+`;
const path = String.raw`(?:~?/)?(?:[\w.\-]+/)*`;
const verify = insensitive(String.raw`(?:^|[\s;&|(])(?:` + path) + python + insensitive(String.raw`\s+)?` + path + String.raw`(?:pytest|py\.test|tox|nox|`) + python + insensitive(String.raw`\s+-m\s+(?:pytest|unittest)|manage\.py\s+test|runtests(?:\.py)?|jest|vitest|mocha|ava|playwright\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|go\s+test|cargo\s+(?:test|nextest)|(?:mvn|mvnw|\./mvnw)\s+(?:\S+\s+)*test|(?:gradle|gradlew|\./gradlew)\s+(?:\S+\s+)*test|make\s+(?:test|check)|ctest|rspec|phpunit|dotnet\s+test|swift\s+test|mix\s+test|rake(?:\s+\w+=\S*)*\s+(?:test|spec)(?::[\w:]+)?|rails\s+test(?::[\w:]+)?|`) + ruby + insensitive(String.raw`(?:[\w.\-~]*/)*(?:test_[\w.\-]*|[\w.\-]*_(?:test|spec))\.rb|deno\s+test|node\s+--test|bazel\s+test|(?:\./)?bin/test)(?![\w.\-/])`);
const unicodeWords = (s: string) => s.replace(/\\w/g, "[\\p{L}\\p{N}_]");
export const VERIFY_RE = new RegExp(unicodeWords(verify).replace(/\[\[\\p\{L\}\\p\{N\}_\]/g, "[\\p{L}\\p{N}_"), "u");
const QUOTED_RE = /'[^']*'|"(?:\\.|[^"\\])*"/g;
const SEP_RE = /(&&|\|\||\|&|(?<!>)\||;|\n)/;
const NOT_A_RUN_RE = /\s(?:-h|--help|--version|--collect-only|--co|--list\S*)(?!\S)/;
const PREFIX_RE = /^\s*(?:(?:[\p{L}\p{N}_]+=\S*|time|nohup|command|nice(?:\s+(?:-n\s*|--adjustment=)?[-+]?\d+)?|env(?:\s+(?:(?:-[uC]|--unset|--chdir)(?:=|\s*)[^\s-]\S*|-[-\w]*))*|timeout(?:\s+(?:-\S+|[A-Z]+|\d\S*))+|(?:(?:uv|poetry|pipenv|pdm|hatch|rye)\s+run|npx|bunx|(?:npm|pnpm|yarn)\s+(?:exec|dlx)|bundle\s+exec|xvfb-run)(?:\s+-\S+)*|dotenv(?:\s+(?!--(?:\s|$))\S+)*\s+--)\s+)*/u;
const REPORT_RE = /^\s*(?:echo|printf|true|:|exit)(?:\s|$)/;
const SHELLS = ["sh", "bash", "zsh", "dash", "ksh"];

function shell_words(cmd: string): string[] {
  const out: string[] = []; let word = "", started = false, quote = "";
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && i + 1 < cmd.length && ['"', "\\", "$", "`", "\n"].includes(cmd[i + 1])) word += cmd[++i];
      else word += c;
    } else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (c === "\\") { if (++i >= cmd.length) throw Error("escape"); word += cmd[i]; started = true; }
    else if (/\s/.test(c)) { if (started) { out.push(word); word = ""; started = false; } }
    else { word += c; started = true; }
  }
  if (quote) throw Error("quote");
  if (started) out.push(word);
  return out;
}
export function _pieces(command: string): [string[], boolean] {
  let cmd = command, parts: string[] = [];
  try { parts = shell_words(cmd); } catch {}
  if (parts.length >= 3 && SHELLS.includes(parts[0].split("/").at(-1)!) && parts[1].startsWith("-") && parts[1].includes("c")) cmd = parts[2];
  cmd = _split_heredocs(cmd)[0];
  const pieces = cmd.replace(QUOTED_RE, "Q").replace(/[(){}]/g, " ").split(SEP_RE);
  while (pieces.length > 1 && !pieces.at(-1)!.trim()) pieces.splice(-2);
  return [pieces, cmd.includes("pipefail")];
}
const QUIET_HEADS = ["cat", "head", "tail", "less", "more", "wc", "sort", "uniq", "cut", "tr", "nl", "column", "ls", "tree", "pwd", "stat", "file", "du", "which", "type", "whereis", "grep", "egrep", "fgrep", "rg", "ag", "jq", "find", "echo", "printf", "true", ":", "cd", "pushd", "popd", "export", "source", ".", "set", "sed", "git"];
const GIT_READS = ["show", "diff", "log", "status", "grep", "ls-files", "blame", "rev-parse", "branch"];
export function _quiet(stage: string): boolean {
  const remaining = (stage.trim() + " ").replace(PREFIX_RE, "").trim();
  if (!remaining) return true;
  const words = remaining.split(/\s+/), head = words[0].split("/").at(-1)!;
  if (!QUIET_HEADS.includes(head)) return false;
  if (head === "git") return words.length > 1 && GIT_READS.includes(words[1]);
  if (head === "sed") return !words.slice(1).some(w => /^(?:-[a-zA-Z]*i|--in-place)/.test(w));
  if (head === "find") return !words.slice(1).some(w => ["-delete", "-exec", "-execdir", "-ok"].includes(w));
  return true;
}
export function exit_status_covers(cmd: string): boolean {
  if (typeof cmd !== "string" || !cmd.trim()) return false;
  const [pieces, pipefail] = _pieces(cmd);
  for (let i = 0; i < pieces.length - 1; i += 2) {
    const sep = pieces[i + 1];
    if (sep === "&&" || (pipefail && ["|", "|&"].includes(sep))) continue;
    if (!_quiet(pieces[i])) return false;
  }
  return true;
}
export function status_of_tests(cmd: string | null | undefined): "own" | "hidden" | "mixed" | null {
  if (typeof cmd !== "string") return null;
  const [pieces, pipefail] = _pieces(cmd), rank = { own: 0, hidden: 1, mixed: 2 };
  let found: "own" | "hidden" | "mixed" | null = null;
  for (let i = 0; i < pieces.length; i += 2) {
    const stage = pieces[i], match = VERIFY_RE.exec(stage.replace(PREFIX_RE, ""));
    if (!match || match.index !== 0 || NOT_A_RUN_RE.test(stage)) continue;
    let status: "own" | "hidden" | "mixed" = "own";
    for (let j = i + 1; j + 1 < pieces.length; j += 2) {
      const sep = pieces[j], then = pieces[j + 1];
      if (sep === "&&" || (pipefail && ["|", "|&"].includes(sep))) continue;
      if (["|", "|&", "||"].includes(sep)) { status = "hidden"; break; }
      if (!REPORT_RE.test(then)) { status = "mixed"; break; }
      status = "hidden";
    }
    if (found === null || rank[status] > rank[found]) found = status;
  }
  return found;
}
const FAILED = [String.raw`\b[1-9]\d* (?:failed|errors?)\b.*\bin \d+(?:\.\d+)?s\b`, String.raw`^FAILED \((?:failures|errors)=`, String.raw`^tests finished:.*\b[1-9]\d* (?:failed|exceptions?)\b`, String.raw`^# fail [1-9]`, String.raw`^Tests:.*\b[1-9]\d* failed\b`, String.raw`^\s*Tests\s+[1-9]\d* failed\b`, String.raw`^\s*[1-9]\d* failing\b`, String.raw`^\s*[1-9]\d* failed\s*$`, String.raw`^(?:--- FAIL: |FAIL\t|FAIL$)`, String.raw`^test result: FAILED`, String.raw`\b\d+ examples?, [1-9]\d* failures?\b`, String.raw`^\d+ (?:runs|tests), \d+ assertions, (?:[1-9]\d* failures, \d+ errors|\d+ failures, [1-9]\d* errors)\b`, String.raw`Tests run: \d+, Failures: (?:[1-9]|0, Errors: [1-9])`, String.raw`BUILD FAIL(?:URE|ED)`];
const PASSED = [String.raw`\b\d+ passed\b.*\bin \d+(?:\.\d+)?s\b`, String.raw`^OK(?: \(.*\))?\s*$`, String.raw`^tests finished: \d+ passed`, String.raw`^# fail 0\b`, String.raw`^Tests:\s+\d+ passed`, String.raw`^\s*Tests\s+\d+ passed`, String.raw`^\s*\d+ passing\b`, String.raw`^\s*\d+ passed \(\d+(?:\.\d+)?(?:ms|s|m|h)\)`, String.raw`^ok\s+\S+\s+(?:\d+(?:\.\d+)?s|\(cached\))`, String.raw`^test result: ok\.`, String.raw`\b\d+ examples?, 0 failures\b`, String.raw`^\d+ (?:runs|tests), \d+ assertions, 0 failures, 0 errors\b`, String.raw`BUILD SUCCESS`];
const boundary = String.raw`(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))`;
const summary = (patterns: string[]) => new RegExp(patterns.join("|").replace(/\\b/g, () => boundary), "mu");
const RUN_FAILED_RE = summary(FAILED), RUN_PASSED_RE = summary(PASSED);
export function runner_verdict(text: string): boolean | null {
  if (!text) return null;
  if (RUN_FAILED_RE.test(text)) return true;
  return RUN_PASSED_RE.test(text) ? false : null;
}
