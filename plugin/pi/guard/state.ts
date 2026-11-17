import { createHash } from "node:crypto";

export const TEST_RUN_RE = /(runtests(\.py)?|(?<![\p{L}\p{N}_])pytest(?![\p{L}\p{N}_])|py\.test|manage\.py\s+test|python\s+-m\s+unittest|(?<![\p{L}\p{N}_])tox(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])nox(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])trial(?![\p{L}\p{N}_])|python\d?\s+-c(?![\p{L}\p{N}_]))/iu;

const GENERAL_ERR_RE = /(Traceback \(most recent call last\)|(?<![\p{L}\p{N}_])[\p{L}\p{N}_]*Error(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])FAILED(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])assert(?![\p{L}\p{N}_])|Exception|errors during collection|^# fail [1-9]|^not ok \d|(?<![\p{L}\p{N}_])[1-9]\d* (?:failing|failures?)(?![\p{L}\p{N}_])|Failures: [1-9])/imu;
const GO_ERR_RE = /^(?:--- FAIL: |FAIL\t|FAIL$)/m;
export const ERR_RE = {
  test(text: string): boolean { return GENERAL_ERR_RE.test(text) || GO_ERR_RE.test(text); },
};

export const EDIT_TOOLS = ["edit", "str_replace", "create"];
export const CONTENT_TOOLS = ["view", "grep", "glob"];
const TOOL_CANON: Record<string, string> = {
  bash: "bash", shell: "bash", read: "view", view: "view", grep: "grep", glob: "glob",
  edit: "edit", multiedit: "edit", str_replace: "edit", apply_patch: "edit",
  write: "create", create: "create",
};

export function canon_tool(name: string | null | undefined): string {
  return TOOL_CANON[(name || "").toLowerCase()] ?? (name || "?");
}

export function basename(path: string): string {
  return path ? path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop()! : (path || "");
}

export function failure_sig(text: string): string | null {
  if (!text) return null;
  const first = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/).find(line => ERR_RE.test(line));
  if (first === undefined) return null;
  const norm = first.replace(/0x[0-9a-f]+|\d+|\/\S+/g, "").trim();
  return createHash("md5").update(norm).digest("hex").slice(0, 10);
}

export class SpiralState {
  turns = 0;
  edit_counts: Record<string, number> = {};
  edit_order: string[] = [];
  error_outputs = 0;
  test_runs = 0;
  fail_sigs: Record<string, number> = {};
  repeated_fail_sigs = 0;
  recent: string[] = [];

  get edit_churn(): number { return Math.max(0, ...Object.values(this.edit_counts)); }
  get distinct_edit_files(): number { return Object.keys(this.edit_counts).length; }
  get stagnation(): number {
    const total = Object.values(this.fail_sigs).reduce((a, b) => a + b, 0);
    return total ? this.repeated_fail_sigs / total : 0;
  }

  update(tool_name: string, args: Record<string, any> | null, result_text: string, failed: boolean | null = null): void {
    this.turns++;
    args = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    tool_name = canon_tool(tool_name);
    let action = tool_name || "?";
    if (EDIT_TOOLS.includes(tool_name)) {
      const paths = Array.isArray(args.paths) && args.paths.length ? args.paths : [args.path || args.filePath || args.file_path];
      const names = [...new Set(paths.filter((p: unknown): p is string => typeof p === "string").map(basename))].filter(Boolean);
      for (const name of names) {
        this.edit_order.push(name);
        this.edit_counts[name] = (this.edit_counts[name] || 0) + 1;
      }
      if (names.length) action = `edit ${names.join(", ")}`;
    }
    const cmd = tool_name === "bash" ? args.command || "" : "";
    if (cmd) {
      action = `$ ${cmd.trim().replace(/\s+/g, " ").slice(0, 90)}`;
      if (TEST_RUN_RE.test(cmd)) this.test_runs++;
    } else if (tool_name === "grep" || tool_name === "glob") {
      action = `${tool_name} ${String(args.pattern || "").slice(0, 40)}`;
    } else if (tool_name === "view") {
      action = `view ${basename(args.path || args.file_path || "")}`;
    }
    let fail: string | null = null;
    const can_fail = CONTENT_TOOLS.includes(tool_name) ? failed === true : failed !== false;
    if (result_text && can_fail && ERR_RE.test(result_text)) {
      this.error_outputs++;
      const sig = failure_sig(result_text);
      if (sig) {
        fail = sig;
        if (Object.hasOwn(this.fail_sigs, sig)) this.repeated_fail_sigs++;
        this.fail_sigs[sig] = (this.fail_sigs[sig] || 0) + 1;
      }
    }
    this.recent.push(`${String(this.turns).padStart(3)}: ${action}${fail ? `  [err#${fail}]` : ""}`);
    if (this.recent.length > 40) this.recent = this.recent.slice(-40);
  }

  recent_digest(n = 24, envelope: number | null = null): string {
    let head = `turns=${this.turns} edit_churn=${this.edit_churn} distinct_edit_files=${this.distinct_edit_files} error_outputs=${this.error_outputs} test_runs=${this.test_runs} repeated_identical_failures=${this.repeated_fail_sigs} stagnation=${this.stagnation.toFixed(2)}`;
    if (envelope) {
      head += `\nrepo_context: tasks here usually RESOLVE within ~${envelope.toFixed(0)} turns; this trajectory is at ${this.turns} turns = ${(this.turns / envelope).toFixed(1)}x that typical length. Tests are still NOT green. A trajectory far past the typical resolved length with recurring failures is likely a dead-end loop, even if it touches many files.`;
    }
    return head + "\nRecent actions (oldest->newest):\n" + this.recent.slice(-n || 0).join("\n");
  }

  snapshot() {
    return { turns: this.turns, edit_churn: this.edit_churn, distinct_edit_files: this.distinct_edit_files,
      error_outputs: this.error_outputs, test_runs: this.test_runs, stagnation: Number(this.stagnation.toFixed(3)),
      repeated_fail_sigs: this.repeated_fail_sigs };
  }
}
