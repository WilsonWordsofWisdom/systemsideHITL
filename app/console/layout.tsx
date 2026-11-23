import type { Metadata } from "next";

// The console is admin only, not linked from any public page and not indexed (FR39).
export const metadata: Metadata = {
  title: "Console · DemoGov Permits",
  robots: { index: false, follow: false },
};

export default function ConsoleLayout({ children }: LayoutProps<"/console">) {
  // Full width (design.md 2.4), breaking out of the 840 px journey column without
  // horizontal page scroll; wide tables scroll inside their own panel.
  return (
    <div className="relative left-1/2 w-[min(1400px,calc(100vw-48px))] -translate-x-1/2">
      {children}
    </div>
  );
}
