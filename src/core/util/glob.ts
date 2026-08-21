// A small glob matcher, shared by the editor extension and the terminal client.
//
// It exists in core rather than in the extension because the rule it implements — "these paths
// never reach a remote provider" — must be identical in both, and because importing the editor's
// module into the CLI would drag the whole `vscode` API into a process that has no editor.

/** `**` crosses directories, `*` stops at one, `?` is a single character. */
export function matchGlob(path: string, glob: string): boolean {
  const rx = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${rx}$`).test(path.replace(/\\/g, "/"));
}

/** The operator's "never send this" list, applied to one path. */
export function isBlockedPath(path: string, globs: string[]): boolean {
  return globs.some((g) => matchGlob(path, g));
}
