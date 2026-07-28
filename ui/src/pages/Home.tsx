/*
 * The placeholder landing page, extracted from App.tsx so the temporary
 * path switch there stays trivial. Task 5.1c's router replaces that switch;
 * Task 5.2 replaces this page with the session list.
 */
export function Home() {
  return (
    <main className="mx-auto max-w-5xl px-8 py-12">
      <h1 className="text-xl font-semibold text-foreground">agent-lens</h1>
      <p className="mt-2 text-sm text-muted">
        Local-first agentic tracing platform. UI coming in Phase 5.
      </p>
      <p className="mt-6 text-xs text-faint">
        Design tokens live at <span className="font-mono text-2xs text-accent">/showcase</span>.
      </p>
    </main>
  );
}
