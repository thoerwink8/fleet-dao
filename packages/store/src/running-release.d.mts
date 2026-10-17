export function diffIsDocsOnly(paths: readonly string[]): boolean;

export function assessRunningRelease(input: {
  current: { sha: string | null } | { error: string };
  running?: {
    engine: { sha: string | null } | { error: string };
    api?: { sha: string | null } | { error: string };
    diffs?: Readonly<Record<string, readonly string[]>>;
  };
}): {
  sha: string | null;
  problem: { code: string; message: string; steady: string; detail: string } | null;
};

export function readRunningRelease(
  dir: string,
  current: { sha: string | null } | { error: string },
  io?: {
    readProc?: (
      unit: 'fleet-engine.service' | 'fleet-api.service',
    ) => { sha: string | null } | { error: string };
    diffNames?: (oldSha: string, newSha: string) => readonly string[] | { error: string };
  },
): {
  engine: { sha: string | null } | { error: string };
  api: { sha: string | null } | { error: string };
  diffs?: Readonly<Record<string, readonly string[]>>;
};
