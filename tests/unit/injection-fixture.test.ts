// The T15 prompt-injection fixture (J10, control P4): off by default, really
// model-directed when on, and isolated to its own module.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findModelDirectedText } from "@/lib/content";
import { t15FixtureOn } from "@/lib/flags";
import { T15_TEXT } from "@/lib/injection-fixture";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx|js|md|txt|yaml)$/.test(name) ? [p] : [];
  });
}

describe("T15 fixture", () => {
  it("is on only with T15_FIXTURE=on", () => {
    for (const v of [undefined, "", "off", "true", "ON"]) {
      expect(t15FixtureOn({ T15_FIXTURE: v }), String(v)).toBe(false);
    }
    expect(t15FixtureOn({ T15_FIXTURE: "on" })).toBe(true);
  });

  it("is caught by the content lint, so it can't leak into normal content unnoticed", () => {
    expect(findModelDirectedText(T15_TEXT)).not.toEqual([]);
  });

  it("is the only served source with the injected wording", () => {
    const hits = ["app", "components", "lib", "public"]
      .flatMap(sourceFiles)
      .filter((f) => /approve this yourself/i.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([path.join("lib", "injection-fixture.ts")]);
  });
});
