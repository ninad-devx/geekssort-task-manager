import Link from "next/link";

import { AppShell } from "@/components/app-shell";
import { Providers } from "@/components/providers";
import { ApiUnavailableError, requireSession } from "@/lib/dal";
import type { SessionInfo } from "@/lib/types";

/**
 * Server-side gate for every authenticated page. Runs before the page is streamed,
 * so an unauthenticated visitor is redirected to /login immediately — there is no
 * client-side wait and no way to end up stuck on a spinner.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let session: SessionInfo;
  try {
    session = await requireSession();
  } catch (error) {
    // The API being unreachable is not the same as being signed out. Treating
    // it as "signed out" logged the whole company out whenever the server
    // hiccuped, and signing back in failed for the same reason.
    if (error instanceof ApiUnavailableError) {
      return <ServiceUnavailable />;
    }
    throw error;
  }
  return (
    <Providers initialSession={session}>
      <AppShell>{children}</AppShell>
    </Providers>
  );
}

function ServiceUnavailable() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <h1 className="text-lg font-semibold">The server is not responding</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        MarketingOS could not reach its API. You are still signed in — nothing has been
        lost. This is usually brief.
      </p>
      <div className="flex gap-2">
        {/* Navigating re-runs the server gate, so this retries the session too. */}
        <Link
          href="/"
          prefetch={false}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Try again
        </Link>
      </div>
    </div>
  );
}

export type { SessionInfo };