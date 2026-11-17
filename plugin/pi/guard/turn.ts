import { SpiralState, canon_tool, ERR_RE, TEST_RUN_RE } from "./state.ts";
import { DEFAULT_THRESHOLDS, assess_abort, is_stuck, nudge_text } from "./rules.ts";
import { fold_shell_edits, shell_edit_targets, shell_revert_targets } from "./shell_edits.ts";
import { status_of_tests, runner_verdict } from "./status.ts";

const SLOTS = ["turns", "edit_counts", "edit_order", "error_outputs", "test_runs", "fail_sigs", "repeated_fail_sigs", "recent"] as const;
type StateData = Partial<Pick<SpiralState, typeof SLOTS[number]>>;
type Verdict = { stuck?: boolean | null; confidence?: number | string | null; reason?: string; _tokens?: number; _nudge?: string };
type SyncJudge = (digest: string) => Verdict | null | undefined;
export type BackgroundJudge = { start(guard: TurnGuard, digest: string): string | null | undefined; poll(guard: TurnGuard): [boolean, Verdict | null | undefined] };
type Thresholds = Record<string, number | boolean>;
type Decision = ["nudge" | "abort", string];
type WriterResult = { text?: string; _tokens?: number } | null | undefined;
type Writer = (digest: string) => WriterResult;

type GuardData = Omit<Partial<TurnGuard>, "st" | "whole"> & { st?: StateData; whole?: StateData };
export function state_to_dict(st: SpiralState): StateData {
  return Object.fromEntries(SLOTS.map(k => [k, st[k]])) as StateData;
}
export function state_from_dict(d: StateData | null | undefined): SpiralState {
  const st = new SpiralState();
  if (d) Object.assign(st, Object.fromEntries(SLOTS.filter(k => Object.hasOwn(d, k)).map(k => [k, d[k]])));
  return st;
}
export class NoVerdict implements BackgroundJudge {
  start(_guard: TurnGuard, _digest: string): null { return null; }
  poll(_guard: TurnGuard): [false, null] { return [false, null]; }
}
export class TurnGuard {
  static readonly JUDGE_BASE_GAP = 5;
  static readonly JUDGE_MAX_GAP = 20;
  static readonly JUDGE_STALE_S = 300;
  static readonly _NOT_GREEN = "Tests are still NOT green.";
  turn_key: string;
  st: SpiralState;
  whole: SpiralState;
  cum_turns: number;
  segment: number;
  nudges_done: number;
  aborted: boolean;
  abort_delivered: boolean;
  events: Record<string, unknown>[];
  judge_last: number;
  judge_gap: number;
  judge_calls: number;
  judge_tokens: number;
  writer_tokens: number;
  last_edit: number;
  last_verify: number;
  last_verify_failed: boolean;
  edits: number;
  verifications: number;
  judge_pending: { id: string; since: number; segment: number } | null;
  nudge_ready: string | null;
  held: Decision | null;

  constructor(turn_key = "", data: GuardData | null = null) {
    const d = data || {};
    this.turn_key = d.turn_key ?? turn_key;
    this.st = state_from_dict(d.st); this.whole = state_from_dict(d.whole);
    this.cum_turns = Number(d.cum_turns ?? 0); this.segment = Number(d.segment ?? 0);
    this.nudges_done = Number(d.nudges_done ?? 0); this.aborted = Boolean(d.aborted ?? false);
    this.abort_delivered = Boolean(d.abort_delivered ?? false); this.events = [...(d.events ?? [])];
    this.judge_last = Number(d.judge_last ?? -999); this.judge_gap = Number(d.judge_gap ?? TurnGuard.JUDGE_BASE_GAP);
    this.judge_calls = Number(d.judge_calls ?? 0); this.judge_tokens = Number(d.judge_tokens || 0);
    this.writer_tokens = Number(d.writer_tokens || 0); this.last_edit = Number(d.last_edit ?? 0);
    this.last_verify = Number(d.last_verify ?? 0); this.last_verify_failed = Boolean(d.last_verify_failed ?? false);
    this.edits = Number(d.edits ?? 0); this.verifications = Number(d.verifications ?? 0);
    this.judge_pending = d.judge_pending || null; this.nudge_ready = d.nudge_ready || null; this.held = d.held || null;
  }
  to_dict() {
    return { turn_key: this.turn_key, st: state_to_dict(this.st), whole: state_to_dict(this.whole),
      cum_turns: this.cum_turns, segment: this.segment, nudges_done: this.nudges_done, aborted: this.aborted,
      abort_delivered: this.abort_delivered, events: this.events.slice(-20), judge_last: this.judge_last,
      judge_gap: this.judge_gap, judge_calls: this.judge_calls, judge_tokens: this.judge_tokens,
      writer_tokens: this.writer_tokens, last_edit: this.last_edit, last_verify: this.last_verify,
      last_verify_failed: this.last_verify_failed, edits: this.edits, verifications: this.verifications,
      judge_pending: this.judge_pending, nudge_ready: this.nudge_ready, held: this.held };
  }
  _track(name: string, args: Record<string, unknown> | null, result: string, exit_code: number | null, shell_edits: string[] = []): void {
    const canon = canon_tool(name);
    if (canon === "edit" || canon === "create") { this.last_edit = this.cum_turns; this.edits++; return; }
    const cmd = canon === "bash" && typeof args?.command === "string" ? args.command : null;
    const verifies = status_of_tests(cmd) !== null;
    if (shell_edits.length) { this.last_edit = this.cum_turns - (verifies ? 1 : 0); this.edits++; }
    if (verifies) {
      this.last_verify = this.cum_turns; this.verifications++;
      this.last_verify_failed = exit_code !== null ? exit_code !== 0 : ERR_RE.test(result || "");
    }
  }
  resolved_proxy(stopped_normally = true): boolean {
    return !!stopped_normally && !this.aborted && this.cum_turns !== 0 && !(this.last_verify_failed && this.last_verify > this.last_edit);
  }
  verification_state(): string {
    if (!this.verifications) return "No test or verification run has been seen in this turn.";
    return `The last verification run ${this.last_verify_failed ? "failed" : "passed"}.${this.last_edit > this.last_verify ? " There have been edits since." : ""}`;
  }
  live_digest(digest: string): string { return (digest || "").replaceAll(TurnGuard._NOT_GREEN, this.verification_state()); }
  _backoff(v: Verdict | null | undefined): void {
    this.judge_gap = v && v.stuck === false ? Math.min(TurnGuard.JUDGE_MAX_GAP, this.judge_gap + TurnGuard.JUDGE_BASE_GAP) : TurnGuard.JUDGE_BASE_GAP;
  }
  _sampled(judge: SyncJudge): SyncJudge {
    return digest => {
      if (this.st.turns - this.judge_last < this.judge_gap) return null;
      this.judge_last = this.st.turns; this.judge_calls++;
      let v: Verdict | null | undefined;
      try { v = judge(this.live_digest(digest)); } catch { v = null; }
      if (v) this.judge_tokens += v._tokens || 0;
      this._backoff(v); return v;
    };
  }
  _background(judge: BackgroundJudge): SyncJudge {
    return digest => {
      const [found, v] = judge.poll(this);
      if (found) {
        this.judge_pending = null;
        if (v && Object.keys(v).length) this.nudge_ready = (v._nudge || "").trim() || null;
        this._backoff(v); return v && Object.keys(v).length ? v : null;
      }
      if (this.judge_pending) {
        if (Date.now() / 1000 - Number(this.judge_pending.since || 0) < TurnGuard.JUDGE_STALE_S) return null;
        this.judge_pending = null;
      }
      if (this.st.turns - this.judge_last < this.judge_gap) return null;
      this.judge_last = this.st.turns; this.judge_calls++;
      const job = judge.start(this, this.live_digest(digest));
      if (job) this.judge_pending = { id: job, since: Date.now() / 1000, segment: this.segment };
      return null;
    };
  }
  fold(name: string, args: Record<string, unknown> | null, result: string, exit_code: number | null = null,
       { envelope = null, thr = null, judge = null, nudge_budget = 1 }: FoldOptions = {}): Decision | null {
    const thresholds = thr && Object.keys(thr).length ? thr : DEFAULT_THRESHOLDS;
    const cmd = canon_tool(name) === "bash" && typeof args?.command === "string" ? args.command : null;
    let shell_edits = cmd != null ? shell_edit_targets(cmd) : [];
    if (shell_edits.length) {
      const reverted = new Set(shell_revert_targets(cmd ?? ""));
      shell_edits = shell_edits.filter(b => !reverted.has(b) || this.whole.edit_counts[b]);
    }
    const status = status_of_tests(cmd);
    if (status === "hidden" || status === "mixed") {
      const verdict = runner_verdict(result);
      if (verdict !== null) exit_code = Number(verdict);
      else if (status === "hidden") exit_code = null;
    }
    const failed = exit_code === null ? null : exit_code !== 0;
    this.st.update(name, args || {}, result || "", failed);
    this.whole.update(name, args || {}, result || "", failed);
    if (status !== null && !TEST_RUN_RE.test(cmd ?? "")) { this.st.test_runs++; this.whole.test_runs++; }
    fold_shell_edits(this.st, shell_edits); fold_shell_edits(this.whole, shell_edits);
    this.cum_turns++; this._track(name, args, result, exit_code, shell_edits);
    if (this.aborted || this.held) return null;
    let backstop = thresholds.backstop_turns as number | undefined;
    if (backstop == null && envelope != null) backstop = envelope * (thresholds.backstop_mult as number);
    if (backstop != null && this.cum_turns >= backstop && is_stuck(this.st, thresholds)) {
      const reason = `cum-backstop:${this.cum_turns}>=${backstop.toFixed(0)}t`;
      return this._stop(this.nudges_done < nudge_budget ? "nudge" : "abort", reason, envelope);
    }
    const wired = judge == null ? null : typeof judge === "function" ? this._sampled(judge) : this._background(judge);
    const [abort, reason] = assess_abort(this.st, envelope, wired, thresholds);
    if (!abort) {
      if (thresholds.nudge_on_ambiguous && reason === "judge-ambiguous-spared" && this.nudges_done < nudge_budget)
        return this._stop("nudge", "ambiguous-past-envelope", envelope);
      return null;
    }
    return this._stop(this.nudges_done < nudge_budget ? "nudge" : "abort", reason, envelope);
  }
  _stop(action: "nudge" | "abort", reason: string, envelope: number | null): Decision {
    this.events.push({ segment: this.segment, action, turn_in_segment: this.st.turns, cum_turns: this.cum_turns,
      envelope, reason, snapshot: this.st.snapshot() });
    if (action === "abort") this.aborted = true;
    return [action, reason];
  }
  nudge_body(envelope: number | null = null, writer: Writer | null = null): string {
    if (this.nudge_ready) { const text = this.nudge_ready; this.nudge_ready = null; return text; }
    if (writer) {
      let out: WriterResult;
      try { out = writer(this.live_digest(this.st.recent_digest(24, envelope))); } catch { out = null; }
      if (out) { this.writer_tokens += out._tokens || 0; const text = (out.text || "").trim(); if (text) return text; }
    }
    return nudge_text(this.st);
  }
  after_nudge(): void {
    this.nudges_done++; this.segment++; this.st = new SpiralState(); this.judge_last = -999;
    this.judge_gap = TurnGuard.JUDGE_BASE_GAP; this.judge_pending = null; this.nudge_ready = null;
  }
  summary(stopped_normally = true) {
    return { turn_key: this.turn_key, tool_calls: this.cum_turns, nudges: this.nudges_done, aborted: this.aborted,
      resolved_proxy: this.resolved_proxy(stopped_normally), edits: this.edits, verifications: this.verifications,
      judge_tokens: this.judge_tokens, writer_tokens: this.writer_tokens };
  }
}
