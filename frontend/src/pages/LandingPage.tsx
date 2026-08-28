export function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-4xl font-bold tracking-tight">
        Kiseki <span className="text-primary">軌跡</span>
      </h1>
      <p className="max-w-sm text-muted-foreground">
        The trip as a living document. Open your trip link to continue.
      </p>
    </div>
  );
}
