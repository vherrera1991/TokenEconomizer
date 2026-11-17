import { readJson, writeJson } from "./session.ts";
import type { GuardPaths } from "./session.ts";
import type { BackgroundJudge, TurnGuard } from "./turn.ts";

type Spawn = (program: string, argv: string[], env: NodeJS.ProcessEnv, cwd: string) => unknown;

export class AsyncJudge implements BackgroundJudge {
  paths: GuardPaths;
  sid: string;
  threshold: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawn: Spawn;

  constructor(paths: GuardPaths, sid: string, threshold: number,
              cwd: string, env: NodeJS.ProcessEnv, spawn: Spawn) {
    this.paths = paths; this.sid = sid; this.threshold = threshold;
    this.cwd = cwd; this.env = env; this.spawn = spawn;
  }

  start(guard: TurnGuard, digest: string): string | null {
    const now = Date.now() / 1000;
    const id = `${guard.turn_key}:${guard.segment}:${guard.judge_calls}:${now.toFixed(3)}`;
    if (!writeJson(this.paths.judgeRequest, { id, session_id: this.sid, turn_key: guard.turn_key,
      segment: guard.segment, digest, threshold: this.threshold, at: now })) return null;
    try {
      this.spawn("te", ["--host", "pi", "--cwd", this.cwd, "judge", "--session", this.sid, "--job", id], this.env, this.cwd);
      return id;
    } catch { return null; }
  }

  poll(guard: TurnGuard): [boolean, { stuck?: boolean | null; confidence?: number | string | null; reason?: string; _tokens?: number; _nudge?: string } | null] {
    if (!guard.judge_pending?.id) return [false, null];
    const result = readJson(this.paths.judgeResult);
    if (!result || result.id !== guard.judge_pending.id) return [false, null];
    const verdict = result.verdict;
    return [true, verdict && typeof verdict === "object" && !Array.isArray(verdict) ? verdict : null];
  }
}
