/**
 * TokenEconomizer for Pi (earendil-works/pi).
 *
 * Pi has no hook protocol -- extensions are functions on its event bus -- so this extension
 * speaks the one the Claude Code and Codex integrations use, on Pi's behalf: every event
 * below becomes one call of the shared dispatcher (`../scripts/te-hook --host pi`, JSON in,
 * JSON out), and the answer is applied with Pi's own levers. All of the mechanism logic lives
 * in the dispatcher; this file only translates.
 *
 *   session_start       -> SessionStart       the learned manual, kept for the session (a
 *                                             resumed one keeps the manual it carries, where
 *                                             the host replays it)
 *   session_switch      -> SessionStart       in-process new/resume/fork: omp rebuilds the prompt and fetches facts again; Pi reuses the carried section when the branch has messages
 *   before_agent_start  -> UserPromptSubmit   opens a prompt-turn; the manual is set as the
 *                                             `tokeneconomizer` system-prompt section, on every
 *                                             prompt, because Pi diffs sections between runs and
 *                                             an omitted one would be recorded as removed
 *   tool_result         -> PostToolUse        the guard; a redirect is delivered as a steering
 *                                             message, a still-stuck notice as a UI notice
 *   agent_end           -> Stop               closes the turn
 *   session_shutdown    -> SessionEnd         hands the session to a detached fold
 *
 * oh-my-pi (`omp`) loads this extension too, and needs two things said differently: its
 * `before_agent_start` carries `systemPrompt: string[]` with no `systemPromptOptions`, so the
 * manual is appended to that array instead of being set as a named section; and a resumed
 * session rebuilds its system prompt rather than replaying what an extension appended (verified
 * on omp 18.22.0), so the facts are offered again at every start, not only a fresh one.
 *
 * Like the hooks on the other agents it fails open: a dispatcher that is missing, slow or
 * broken answers "no change". It does nothing under TE_SIDECALL=1 (the plugin's own side
 * calls) or TE_DISABLE=1. `/te <command>` runs the `te` command line for this repository.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { TurnGuard } from "./guard/turn.ts";
import { AsyncJudge } from "./guard/judge.ts";
import { patchSession, readSession, resolvePaths } from "./guard/session.ts";
import type { GuardPaths } from "./guard/session.ts";

const HERE = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return __dirname;
  }
})();
const SCRIPTS = join(HERE, "..", "scripts");
const HOOK_TIMEOUT_MS = 60_000;
const SECTION = "tokeneconomizer";
let ompHost = false;
const ompEnv = (): Record<string, string> =>
  ompHost ? { TE_OMP_SIDECALL: "1", TE_OMP_CLI: process.execPath || "omp" } : {};
let guardQueue: Promise<void> = Promise.resolve();
type GuardView = {
  enabled: boolean; loopguard: string; shadow: boolean; nudge_budget: number;
  envelope: number | null; thresholds: Record<string, number | boolean>; judge: boolean;
};

const truthy = (v: string | undefined) => ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());

/** The program and arguments that run a launcher. The launchers are POSIX `sh`, which Windows
 * cannot start; there the bootstrap they run is started with Python itself (`TE_PYTHON`, else
 * `python`). */
export function launch(
  script: string,
  args: string[],
  platform: string = process.platform,
): [string, string[]] {
  if (platform !== "win32") return [join(SCRIPTS, script), args];
  const mode = script === "te-hook" ? "hook" : "cli";
  return [process.env.TE_PYTHON || "python", [join(SCRIPTS, "te_bootstrap.py"), mode, ...args]];
}

/** Run one of the plugin's launchers with `input` on stdin; resolve to its stdout. */
function run(
  script: string,
  args: string[],
  input: string,
  mode: string,
  extra: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      const [program, argv] = launch(script, args);
      // UTF-8 mode as the launchers set it, for where they are bypassed (Windows).
      child = spawn(program, argv, {
        env: { ...process.env, PYTHONUTF8: "1", TE_PI_MODE: mode, ...extra },
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve("");
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("");
    }, HOOK_TIMEOUT_MS);
    // Decoded as a stream, so a character split across two chunks arrives whole.
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (out += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** One dispatcher call; `{}` (no change) on any failure. */
async function hook(payload: Record<string, unknown>, mode: string): Promise<any> {
  if (truthy(process.env.TE_SIDECALL) || truthy(process.env.TE_DISABLE)) return {};
  const out = await run("te-hook", ["--host", "pi"], JSON.stringify(payload), mode, ompEnv());
  try {
    return JSON.parse(out.trim().split("\n").pop() || "{}") ?? {};
  } catch {
    return {};
  }
}

/** A notice in the UI; on stderr in print and JSON modes, which have no UI and keep stdout for
 * the reply and the event stream -- so a headless stop, too, says why it happened. */
function notify(ctx: ExtensionContext, text: unknown) {
  if (typeof text !== "string" || !text) return;
  if (ctx.hasUI) ctx.ui.notify(text, "info");
  else console.error(text);
}

const SOURCE: Record<string, string> = {
  // For a conversation that starts empty. One that already holds messages is a resumption,
  // whatever the reason says (`carriedSection`).
  startup: "startup",
  new: "clear",
  resume: "resume",
  fork: "resume",
  reload: "resume",
};

/** The section a conversation that already holds messages carries. Pi replays its system
 * entries -- each patches `sections` by name, `null` removing one, and a compaction restates
 * them all -- into the leading system message of every request, so such a conversation must
 * be given the same text again: leaving it out records it as removed, and the facts are gone;
 * new facts would change the system message. Either way the whole conversation would be
 * re-read at the uncached price. Pi says "startup", not "resume", for a conversation opened
 * with `pi -c` or `--session`, so the messages decide (both verified on Pi 1.3.0). */
export function carriedSection(entries: any[]): string {
  let text = "";
  for (const entry of entries) {
    if (entry?.type === "compaction" && entry.systemMessage?.sections) {
      text = entry.systemMessage.sections[SECTION] ?? "";
    } else if (entry?.type === "message" && entry.message?.role === "system"
               && entry.message.sections && SECTION in entry.message.sections) {
      text = entry.message.sections[SECTION] ?? "";
    }
  }
  // Pi stores a section as it renders it, `<name>\n...\n</name>`, and wraps what it is given.
  const open = `<${SECTION}>\n`;
  const close = `\n</${SECTION}>`;
  return text.startsWith(open) && text.endsWith(close)
    ? text.slice(open.length, text.length - close.length)
    : text;
}

/** Both Pi and omp expose the same tool APIs, so the session location identifies omp. */
export function isOmp(ctx?: ExtensionContext): boolean {
  return /[\\/]\.omp[\\/]/.test(ctx?.sessionManager?.getSessionFile?.() ?? "");
}

export function pruneActive(active: string[], deny: string[]): string[] {
  const denied = new Set(deny);
  return active.filter((name) => !denied.has(name));
}

export function exitCodeOf(event: any): number | undefined {
  if (typeof event?.structuredContent?.exit_code === "number") return event.structuredContent.exit_code;
  if (typeof event?.details?.exitCode === "number") return event.details.exitCode;
  return undefined;
}

/** The manual as Pi renders a section, for a host that takes bare system-prompt blocks. */
function sectionText(text: string): string {
  return `<${SECTION}>\n${text}\n</${SECTION}>`;
}

export default function tokeneconomizer(pi: ExtensionAPI) {
  let manual = "";
  let prompts = 0;
  let turn = "";
  let guardView: GuardView | null = null;
  let guardPaths: GuardPaths | null = null;
  let turnGuard: TurnGuard | null = null;
  let judge: AsyncJudge | null = null;
  let nudges = 0, aborts = 0;
  let current: { session_id: string; transcript_path: string; cwd: string } | null = null;

  const persist = () => {
    if (guardPaths && turnGuard)
      patchSession(guardPaths, { turn: turnGuard.to_dict(), nudges, aborts, updated: Date.now() / 1000 });
  };

  const base = (ctx: ExtensionContext) => ({
    session_id: ctx.sessionManager.getSessionId(),
    transcript_path: ctx.sessionManager.getSessionFile() ?? "",
    cwd: ctx.cwd,
  });

  const openSession = async (source: string, ctx: ExtensionContext, omp: boolean) => {
    prompts = 0;
    turn = "";
    const entries = (ctx.sessionManager.getBranch?.() ?? []) as any[];
    const carried = entries.some((e) => e?.type === "message");
    // omp rebuilds the system prompt for a resumed session instead of replaying what the
    // extension appended, so the facts are asked for again: "startup" is the source that makes
    // the dispatcher offer them (the same text, so the conversation stays cache-stable).
    const dispatchSource = omp ? "startup" : carried ? "resume" : source;
    const payload: Record<string, unknown> = { ...base(ctx), hook_event_name: "SessionStart", source: dispatchSource };
    if (omp) {
      try {
        payload.tool_catalog = pi.getAllTools().map((tool) => tool.name);
      } catch {
        // A catalog failure must not prevent the session from starting.
      }
    }
    const out = await hook(payload, ctx.mode);
    current = base(ctx);
    guardView = out?.tokeneconomizer?.guard ?? null;
    turnGuard = null;
    judge = null;
    guardPaths = resolvePaths(process.env.TOKENECONOMIZER_HOME || join(homedir(), ".tokeneconomizer"), current.session_id);
    const record = guardPaths && readSession(guardPaths);
    nudges = Number(record?.nudges ?? 0);
    aborts = Number(record?.aborts ?? 0);
    manual = omp
      ? out?.hookSpecificOutput?.additionalContext ?? ""
      : carried
        ? carriedSection(entries)
        : out?.hookSpecificOutput?.additionalContext ?? "";
    notify(ctx, out?.systemMessage);
    if (omp) {
      try {
        const deny = out?.tokeneconomizer?.toolprune?.apply;
        if (Array.isArray(deny) && deny.length > 0 && deny.every((name) => typeof name === "string")) {
          const active = pi.getActiveTools();
          const next = pruneActive(active, deny);
          if (next.length < active.length) {
            await pi.setActiveTools(next);
            notify(ctx, `TokenEconomizer: removed ${active.length - next.length} tool(s) for this session; toolprune=off restores them next session.`);
          }
        }
      } catch {
        // Pruning must not prevent the learned facts from reaching the session.
      }
    }
  };

  pi.on("session_start", async (event, ctx) => {
    ompHost = isOmp(ctx);
    await openSession(SOURCE[event.reason] ?? "startup", ctx, ompHost);
  });

  pi.on("session_switch", async (event, ctx) => {
    await guardQueue;
    persist();
    if (current) await hook({ ...current, hook_event_name: "SessionEnd", reason: "switch" }, ctx.mode);
    ompHost = isOmp(ctx);
    await openSession(SOURCE[event.reason] ?? "startup", ctx, ompHost);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    prompts += 1;
    turn = `${current?.session_id ?? ctx.sessionManager.getSessionId()}:${prompts}`;
    turnGuard = guardView?.enabled && guardPaths ? new TurnGuard(turn) : null;
    persist();
    if (!manual) return;
    const options = (event as any).systemPromptOptions;
    if (options) {
      options.sections = { ...(options.sections ?? {}), [SECTION]: manual };
      return;
    }
    // omp hands the system prompt over as blocks and takes a replacement array back.
    if (Array.isArray((event as any).systemPrompt)) {
      return { systemPrompt: [...(event as any).systemPrompt, sectionText(manual)] };
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const work = guardQueue.then(() => {
      if (!turnGuard || !guardPaths || !guardView?.enabled || guardView.loopguard === "off") return;
      const content = (event.content ?? [])
        .filter((c: any) => c?.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      if (guardView.judge && !judge) {
        judge = new AsyncJudge(guardPaths, current!.session_id, Number(guardView.thresholds?.judge_confidence || 0),
          current!.cwd, { ...process.env, ...ompEnv(), TE_SIDECALL: "1" }, (script, args, env, cwd) => {
            const [program, argv] = launch(script, args);
            const child = spawn(program, argv, { env, cwd, detached: true, stdio: "ignore" });
            child.on("error", () => {});
            child.unref();
          });
      }
      const decision = turnGuard.fold(event.toolName, event.input ?? {}, content, exitCodeOf(event) ?? null, {
        envelope: guardView.envelope ?? null, thr: guardView.thresholds ?? null,
        judge: guardView.judge ? judge : null, nudge_budget: guardView.nudge_budget,
      });
      if (decision) {
        const [action, reason] = decision;
        const short = reason.split(":")[0];
        if (action === "nudge") {
          const body = turnGuard.nudge_body(guardView.envelope ?? null);
          turnGuard.after_nudge();
          nudges++;
          if (!guardView.shadow) {
            pi.sendMessage({ customType: SECTION, content: body, display: true }, { deliverAs: "steer" });
            notify(ctx, `TokenEconomizer nudged this turn (${short}): the same failure kept recurring.`);
          }
        } else if (!turnGuard.abort_delivered) {
          turnGuard.abort_delivered = true;
          aborts++;
          if (!guardView.shadow) {
            const hint = ["print", "json", "rpc"].includes(ctx.mode)
              ? "Press Ctrl+C to end the run; a command it started runs on until it finishes."
              : "Press Esc to abort it.";
            notify(ctx, `TokenEconomizer: this turn still looks stuck after a redirect (${short}, ${turnGuard.cum_turns} tool calls). ${hint}`);
          }
        }
      }
      persist();
    });
    guardQueue = work.catch(() => {});
    await guardQueue;
  });

  pi.on("agent_end", async (event, ctx) => {
    if ("willContinue" in event && event.willContinue === true) return;
    await guardQueue;
    persist();
    const out = await hook({ ...base(ctx), hook_event_name: "Stop", prompt_id: turn, stop_hook_active: false }, ctx.mode);
    guardView = out?.tokeneconomizer?.guard ?? null;
    turnGuard = null;
  });

  pi.on("session_shutdown", async (event, ctx) => {
    await guardQueue;
    persist();
    await hook({ ...(current ?? base(ctx)), hook_event_name: "SessionEnd", reason: event.reason }, ctx.mode);
  });

  pi.registerCommand("te", {
    description: "TokenEconomizer: status | microskills | config | repos (what it learned here, what it did)",
    handler: async (args, ctx) => {
      // `te` splits the line itself (shlex), so a quoted fact id with spaces stays one argument.
      const argv = ["--argline", (args || "").trim() || "status"];
      // The session id lets `te status` say when this session is recorded under the repository
      // it started in rather than the one `ctx.cwd` is in now.
      const out = await run("te", ["--host", "pi", "--cwd", ctx.cwd, ...argv], "", ctx.mode, {
        ...ompEnv(),
        TE_SESSION_ID: ctx.sessionManager.getSessionId(),
      });
      notify(ctx, out.trim() || "te: no output (is Python 3.10+ on PATH?)");
    },
  });
}
