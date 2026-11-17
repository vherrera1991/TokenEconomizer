import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type GuardPaths = {
  pin: string; host: string; session: string; judgeRequest: string; judgeResult: string; repomap: string;
};

export function safeSid(sid: string): string {
  return sid.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
}

export function readJson(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

export function writeJson(path: string, value: unknown): boolean {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    renameSync(temp, path);
    return true;
  } catch {
    try { unlinkSync(temp); } catch {}
    return false;
  }
}

export function sessionPath(root: string, key: string, sid: string): string {
  return join(root, "repos", key, "pi", "sessions", `${sid}.json`);
}

export function resolvePaths(root: string, sid: string): GuardPaths | null {
  const pin = join(root, "sessions", "pi", `${safeSid(sid)}.json`);
  const key = readJson(pin)?.key;
  if (typeof key !== "string" || !key || key === "." || key === ".." || key.includes("/") || key.includes("\\")) return null;
  const repo = join(root, "repos", key);
  const host = join(repo, "pi");
  return { pin, host, session: sessionPath(root, key, sid),
    judgeRequest: join(host, "judge", `${sid}.request.json`),
    judgeResult: join(host, "judge", `${sid}.result.json`), repomap: join(repo, "repomap.json") };
}

export function readSession(paths: GuardPaths): Record<string, unknown> | null {
  return readJson(paths.session);
}

type SessionPatch = Partial<Record<"turn" | "nudges" | "aborts" | "updated" | "repomap_done" | "repomap_chars", unknown>>;
export function patchSession(paths: GuardPaths, patch: SessionPatch): boolean {
  const record = readSession(paths);
  if (!record) return false;
  for (const key of ["turn", "nudges", "aborts", "updated", "repomap_done", "repomap_chars"] as const)
    if (Object.hasOwn(patch, key)) record[key] = patch[key];
  return writeJson(paths.session, record);
}
