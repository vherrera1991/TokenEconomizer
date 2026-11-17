import { basename, type SpiralState } from "./state.ts";

const HEREDOC_START = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][\p{L}\p{N}_]*)\1/u;
const OPS: Record<string, true> = { "&&": true, "||": true, ";": true, ";;": true, "|": true, "|&": true, "&": true, "\n": true, "(": true, ")": true };
const OUT: Record<string, true> = { ">": true, ">>": true, ">|": true, "&>": true, "&>>": true };
const SKIP: Record<string, true> = { "<": true, "<<": true, "<<<": true, "<&": true, ">&": true, "<>": true };
const SOURCE = /\.(?:py|pyi|pyx|pxd|js|jsx|mjs|cjs|ts|tsx|rs|go|java|kt|kts|scala|c|cc|cpp|cxx|h|hh|hpp|rb|php|cs|swift|m|mm|sh|bash|zsh|lua|jl|ex|exs|erl|hs|ml|clj|sql|toml|ya?ml|json|cfg|ini|conf|md|rst|html?|css|scss|vue|svelte|xml|gradle|properties|in)$/i;
const unquote = (s: string) => s.length >= 2 && (s[0] === "'" || s[0] === '"') && s.at(-1) === s[0] ? s.slice(1, -1) : s;
const not_scratch = (s: string) => !!s && !["/dev/", "/proc/", "/tmp/"].some(p => s.startsWith(p));

export function _split_heredocs(cmd: string): [string, string[]] {
  const shell: string[] = [], bodies: string[] = [];
  let tag: string | null = null, body: string[] = [];
  for (const line of cmd.split("\n")) {
    if (tag !== null) {
      if (line.trim() === tag) { bodies.push(body.join("\n")); tag = null; body = []; }
      else body.push(line);
    } else {
      shell.push(line);
      const m = HEREDOC_START.exec(line);
      if (m) tag = m[2];
    }
  }
  if (tag !== null) bodies.push(body.join("\n"));
  return [shell.join("\n"), bodies];
}

function tokens(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (/[ \t\r]/.test(text[i])) { i++; continue; }
    const start = i, c = text[i];
    if (c === "'" || c === '"') {
      i++;
      while (i < text.length && text[i] !== c) i++;
      if (i === text.length) throw Error("unbalanced quote");
      out.push(text.slice(start, ++i));
    } else if (/[();<>|&\n]/.test(c)) {
      while (i < text.length && /[();<>|&\n]/.test(text[i])) i++;
      out.push(text.slice(start, i));
    } else {
      while (i < text.length && !/[ \t\r();<>|&\n]/.test(text[i])) i++;
      out.push(text.slice(start, i));
    }
  }
  return out;
}
function commands(shell: string): [string[][], string[]] {
  let streams: string[][];
  try { streams = [tokens(shell)]; }
  catch { streams = []; for (const line of shell.split("\n")) { try { streams.push([...tokens(line), "\n"]); } catch {} } }
  const cmds: string[][] = [], writes: string[] = [];
  for (const stream of streams) {
    let cur: string[] = [];
    for (let i = 0; i < stream.length; i++) {
      const t = stream[i];
      if (Object.hasOwn(OPS, t)) { if (cur.length) cmds.push(cur); cur = []; }
      else if (Object.hasOwn(OUT, t) || Object.hasOwn(SKIP, t)) {
        if (cur.length && /^\d+$/.test(cur.at(-1)!)) cur.pop();
        if (Object.hasOwn(OUT, t) && i + 1 < stream.length && !Object.hasOwn(OPS, stream[i + 1])) writes.push(unquote(stream[i + 1]));
        i++;
      } else cur.push(unquote(t));
    }
    if (cur.length) cmds.push(cur);
  }
  return [cmds, writes];
}
function short_script_flag(t: string, letters: string, stop: string): string | null {
  if (t.startsWith("--") || t.length < 2) return null;
  for (let i = 1; i < t.length; i++) {
    if (stop.includes(t[i])) return null;
    if (letters.includes(t[i])) return i + 1 < t.length ? "inline" : "next";
  }
  return null;
}
function inplace_files(ts: string[], inplace: (t: string) => boolean, flag: (t: string) => string | null): string[] {
  if (!ts.slice(1).some(inplace)) return [];
  const files: string[] = []; let have = false, skip = false;
  for (const t of ts.slice(1)) {
    if (skip) { skip = false; have = true; continue; }
    if (!t || t.startsWith("-")) { const where = t ? flag(t) : null; if (where === "next") skip = true; else if (where === "inline") have = true; continue; }
    if (!have) { have = true; continue; }
    files.push(t);
  }
  return files;
}
const sed_flag = (t: string) => ["--expression", "--file"].includes(t) ? "next" : /^(--expression|--file)=/.test(t) ? "inline" : short_script_flag(t, "ef", "i");
const GIT_OPTS: Record<string, true> = { "-C": true, "-c": true, "--git-dir": true, "--work-tree": true, "--namespace": true, "--config-env": true, "--attr-source": true };
function git_args(ts: string[]): string[] {
  if (ts[0].split("/").at(-1) !== "git") return [];
  let i = 1; while (i < ts.length && ts[i].startsWith("-")) i += Object.hasOwn(GIT_OPTS, ts[i]) ? 2 : 1;
  return ts.slice(i);
}
function restored(ts: string[]): string[] {
  const args = git_args(ts);
  if (args.length < 2 || !["checkout", "restore"].includes(args[0])) return [];
  const sep = args.indexOf("--");
  return (sep >= 0 ? args.slice(sep + 1) : args[0] === "restore" ? args.slice(1) : []).filter(t => !t.startsWith("-"));
}
const WRAPPERS: Record<string, string[]> = {
  sudo: ["-u", "-g", "-p", "-C", "-D", "-R", "-r", "-t", "-T", "-U", "--user", "--group", "--prompt", "--close-from", "--chdir", "--chroot", "--role", "--type", "--command-timeout", "--other-user"],
  env: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"], timeout: ["-s", "-k", "--signal", "--kill-after"],
  nice: ["-n", "--adjustment"], time: ["-f", "-o", "--format", "--output"], command: [], nohup: [],
};
function past_wrapper(ts: string[]): string[] {
  const values = WRAPPERS[ts[0]]; let i = 1;
  while (i < ts.length && ts[i].startsWith("-")) {
    const t = ts[i++]; if (t === "--") break;
    if (t.startsWith("--")) { if (values.includes(t)) i++; continue; }
    for (let j = 1; j < t.length; j++) if (values.includes("-" + t[j])) { if (j + 1 === t.length) i++; break; }
  }
  if (ts[0] === "timeout") i++;
  return ts.slice(i);
}
function bare(cmds: string[][]): string[][] {
  const out: string[][] = [];
  for (let ts of cmds) {
    while (ts.length) {
      if (Object.hasOwn(WRAPPERS, ts[0])) ts = past_wrapper(ts);
      else if (/^[\p{L}\p{N}_]+=/u.test(ts[0])) ts = ts.slice(1);
      else break;
    }
    if (ts.length) out.push(ts);
  }
  return out;
}
function py_writes(text: string): string[] {
  const out: string[] = [], vars: string[] = [];
  for (const m of text.matchAll(/open\(\s*(['"])([^'"\n]+)\1\s*,\s*(['"])([^'"]*)\3/g)) if (/[wax+]/.test(m[4])) out.push(m[2]);
  for (const m of text.matchAll(/open\(\s*([A-Za-z_][\p{L}\p{N}_]*)\s*,\s*(['"])([^'"]*)\2/gu)) if (/[wax+]/.test(m[3])) vars.push(m[1]);
  for (const m of text.matchAll(/(?:pathlib\.)?Path\(\s*(['"])([^'"\n]+)\1\s*\)\.write_(?:text|bytes)\(/g)) out.push(m[2]);
  for (const m of text.matchAll(/(?<![\p{L}\p{N}_])([A-Za-z_][\p{L}\p{N}_]*)\.write_(?:text|bytes)\(/gu)) vars.push(m[1]);
  for (const v of new Set(vars)) {
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const found = [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}\\s*=\\s*(?:(?:pathlib\\.)?Path\\(\\s*)?(['"])([^'"\\n]+)\\1`, "gu"))].map(m => m[2]);
    const loop = new RegExp(`(?<![\\p{L}\\p{N}_])for\\s+${escaped}\\s+in\\s+[\\[(]([^\\])]*)[\\])]`, "u").exec(text);
    if (loop) found.push(...[...loop[1].matchAll(/['"]([^'"\n]+)['"]/g)].map(m => m[1]));
    out.push(...(found.length ? found : ["(script)"]));
  }
  return out;
}
const unique_names = (paths: string[]) => [...new Set(paths.filter(p => p.startsWith("(") || not_scratch(p)).map(p => p.startsWith("(") ? p : basename(p)).filter(Boolean))];
export function shell_revert_targets(cmd: string): string[] {
  if (typeof cmd !== "string" || !cmd.trim()) return [];
  const [cmds] = commands(_split_heredocs(cmd)[0]);
  return [...new Set(bare(cmds).flatMap(restored).filter(not_scratch).map(basename).filter(Boolean))];
}
export function shell_edit_targets(cmd: string): string[] {
  if (typeof cmd !== "string" || !cmd.trim()) return [];
  const [shell, bodies] = _split_heredocs(cmd), [cmds, writes] = commands(shell);
  const found = writes.filter(w => SOURCE.test(w));
  for (const ts of bare(cmds)) {
    const head = ts[0].split("/").at(-1);
    if (head === "sed") found.push(...inplace_files(ts, t => /^(?:-[a-zA-Z]*i|--in-place)/.test(t), sed_flag));
    else if (head === "perl") found.push(...inplace_files(ts, t => /^-[a-zA-Z]*i/.test(t), t => short_script_flag(t, "eE", "iIMmxdDC")));
    else if (head === "tee") found.push(...ts.slice(1).filter(t => !t.startsWith("-") && SOURCE.test(t)));
    else if (head === "apply_patch") { const matches = [...[...bodies, ts.slice(1).join(" ")].join("\n").matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$/gm)].map(m => m[1]); found.push(...(matches.length ? matches : ["(patch)"])); }
    else if (head === "patch" || git_args(ts)[0] === "apply") found.push("(patch)");
    else found.push(...restored(ts));
  }
  if (/(?:^|[\s/;&|(])python\d?(?:\.\d+)?(?![\p{L}\p{N}_])/u.test(shell)) found.push(...py_writes([shell, ...bodies].join("\n")));
  return unique_names(found);
}
export function fold_shell_edits(st: SpiralState, names: string[]): void {
  for (const b of names) { st.edit_order.push(b); st.edit_counts[b] = (st.edit_counts[b] || 0) + 1; }
  if (names.length && st.recent.length) st.recent[st.recent.length - 1] += `  [edits ${names.slice(0, 4).join(", ")}${names.length > 4 ? ", ..." : ""}]`;
}
