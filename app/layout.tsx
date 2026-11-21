import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DemoGov Permits",
  description: "A fictional permit service prototype. Demo data only.",
};

// Root layout: prototype banner on every page (control D5), app bar, landmarks (design.md section 5).
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col bg-surface text-on-surface">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:rounded focus:bg-primary focus:px-4 focus:py-2 focus:text-on-primary"
        >
          Skip to main content
        </a>
        <div
          role="note"
          className="bg-warning-container px-4 py-1.5 text-center text-sm font-medium text-on-warning-container"
        >
          Prototype for testing, not a real government service. Demo data only.
        </div>
        <header className="flex items-center gap-3 border-b border-outline-variant px-6 py-3">
          <span
            aria-hidden="true"
            className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-xs font-bold text-on-primary"
          >
            DG
          </span>
          <span className="text-lg font-medium">DemoGov Permits</span>
        </header>
        <main id="main" className="mx-auto w-full max-w-[840px] flex-1 px-6 py-8">
          {children}
        </main>
        <footer className="border-t border-outline-variant px-6 py-4 text-xs text-on-surface-variant">
          DemoGov Permits is fictional. Prototype version 0.1.
        </footer>
      </body>
    </html>
  );
}
