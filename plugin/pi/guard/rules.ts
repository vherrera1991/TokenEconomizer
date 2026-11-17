import type { SpiralState } from "./state.ts";

export const DEFAULT_THRESHOLDS: Record<string, number | boolean> = {
  min_turns: 20, edit_churn: 4, distinct_edit_files: 3, error_outputs: 6, stagnation: 0.20,
  envelope_margin: 1.25, envelope_pct: 90, envelope_min_samples: 5, judge_confidence: 0.7,
  backstop_mult: 2.5, gate_min_turns: 18, gate_error_outputs: 8,
};
export const SPIRAL_LEVELS: Record<string, Record<string, number | boolean>> = {
  conservative: { judge_confidence: 0.85, envelope_margin: 1.5, backstop_mult: 3.5,
    stagnation: 0.30, gate_min_turns: 24, min_turns: 28, edit_churn: 5, error_outputs: 8, envelope_min_samples: 7 },
  default: {},
  aggressive: { judge_confidence: 0.55, envelope_margin: 1.0, backstop_mult: 1.8,
    stagnation: 0.12, gate_min_turns: 12, min_turns: 14, edit_churn: 3, error_outputs: 4,
    envelope_min_samples: 3, nudge_on_ambiguous: true },
};
type Thresholds = Record<string, number | boolean>;
type Verdict = { stuck?: boolean | null; confidence?: number | string | null; reason?: string };
type Judge = (digest: string) => Verdict | null | undefined;

export function scaled_thresholds(level = "default"): Thresholds {
  return { ...DEFAULT_THRESHOLDS, ...(SPIRAL_LEVELS[level] ?? SPIRAL_LEVELS.default) };
}
export function gate_for_judge(state: SpiralState, thr: Thresholds = DEFAULT_THRESHOLDS): boolean {
  if (state.turns < (thr.gate_min_turns as number)) return false;
  return state.repeated_fail_sigs >= 1 || state.error_outputs >= (thr.gate_error_outputs as number);
}
export function is_stuck(state: SpiralState, thr: Thresholds = DEFAULT_THRESHOLDS): boolean {
  if (state.turns < (thr.min_turns as number)) return false;
  const churny = state.edit_churn >= (thr.edit_churn as number) || state.distinct_edit_files >= (thr.distinct_edit_files as number);
  return churny && state.error_outputs >= (thr.error_outputs as number) && state.stagnation >= (thr.stagnation as number);
}
export function assess_abort(state: SpiralState, envelope: number | null = null, judge: Judge | null = null,
                             thr: Thresholds = DEFAULT_THRESHOLDS): [boolean, string] {
  let backstop = thr.backstop_turns as number | undefined;
  if (backstop == null && envelope != null) backstop = envelope * (thr.backstop_mult as number);
  if (backstop != null && state.turns >= backstop && is_stuck(state, thr)) {
    return [true, `backstop:${state.turns}>=${backstop.toFixed(0)}turns stagnation=${state.stagnation.toFixed(2)}`];
  }
  if (judge != null) {
    const over = envelope != null && state.turns >= envelope && (thr.gate_over_envelope ?? true);
    if (!(gate_for_judge(state, thr) || over)) return [false, "gate-closed"];
    let verdict: Verdict | null | undefined;
    try { verdict = judge(state.recent_digest(24, envelope)); } catch { verdict = null; }
    if (!verdict || !Object.keys(verdict).length) return [false, "judge-throttled"];
    const confidence = Number(verdict.confidence || 0);
    if (verdict.stuck && confidence >= (thr.judge_confidence as number)) {
      return [true, `judge-stuck@${confidence.toFixed(2)}:${String(verdict.reason ?? "").slice(0, 60)}`];
    }
    if (verdict.stuck === false) return [false, "judge-productive"];
    return [false, "judge-ambiguous-spared"];
  }
  if (!is_stuck(state, thr)) return [false, "not-stuck"];
  if (envelope != null && state.turns >= envelope) return [true, `envelope:${state.turns}>=${envelope.toFixed(0)}`];
  return [false, "stuck-but-within-envelope"];
}
export function nudge_text(state: SpiralState): string {
  let busiest = "one file", max = 0, edits = 0;
  for (const [name, count] of Object.entries(state.edit_counts)) {
    edits += count;
    if (count > max) { max = count; busiest = name; }
  }
  return `Process check (automated): so far you've made ${edits} edits across ${state.distinct_edit_files} file(s) (most to \`${busiest}\`) and run ${state.test_runs} verification(s), and the same failure has recurred ${state.repeated_fail_sigs} time(s) without the tests going green. This looks like a repetitive loop. Do NOT stop — instead step back and try a MATERIALLY DIFFERENT hypothesis: re-read the failing test's expectation, consider a different file or root cause than the ones you've been editing, and verify the new hypothesis directly before editing again.`;
}
