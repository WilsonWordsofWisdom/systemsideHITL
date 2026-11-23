// Phrases that address a model rather than the person (FR25, control P1).
// Agent-visible content must not match any of them; the T15 fixture is the only
// allowed exception.
export const MODEL_DIRECTED_PATTERNS: RegExp[] = [
  /ignore (all |any |the )?(previous|prior|above) (instructions|messages)/i,
  /\byou must\b/i,
  /\bas an ai\b/i,
  /\bdisregard\b/i,
  /\bsystem prompt\b/i,
  /\bapprove (this|it) yourself\b/i,
  /\byour instructions\b/i,
];

export function findModelDirectedText(text: string): string[] {
  return MODEL_DIRECTED_PATTERNS.filter((p) => p.test(text)).map((p) => p.source);
}
