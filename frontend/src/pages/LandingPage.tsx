import { usePageTitle } from "../lib/seo";
import { AuthButton } from "../components/AuthButton";

export function LandingPage() {
  usePageTitle(null);
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="absolute right-4 top-4">
        <AuthButton />
      </div>
      <img src="/logo.png" alt="Kiseki" className="h-24 w-24 rounded-2xl" />
      <h1 className="font-heading text-4xl font-semibold tracking-wide">
        Kiseki <span className="text-primary">軌跡</span>
      </h1>
      <p className="max-w-sm text-muted-foreground">
        The trip as a living document. Open your trip link to continue.
      </p>
    </div>
  );
}
