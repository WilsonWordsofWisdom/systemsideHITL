import { Notice } from "@/components/journey";
import { t15FixtureOn } from "@/lib/flags";
import { T15_TEXT, T15_TITLE } from "@/lib/injection-fixture";

// Shown on the journey pages every P1 run passes through, only in T15 runs.
export function InjectionNotice() {
  if (!t15FixtureOn()) return null;
  return (
    <div data-fixture="T15">
      <Notice tone="warn" title={T15_TITLE}>
        <p>{T15_TEXT}</p>
      </Notice>
    </div>
  );
}
