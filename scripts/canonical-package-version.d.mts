export function validateNote(
  text: string,
  allowed: readonly string[],
): {
  summary: string;
  releases: { name: string; type: "patch" | "minor" | "major" }[];
};
export function canonical(base: string, head: string, cwd: string): { pending: number };

export function run(command: string, args: string[], cwd: string): string;
export function notes(cwd: string, allowed: readonly string[]): string[];
export function generate(cwd: string, check?: boolean): { pending: number };
