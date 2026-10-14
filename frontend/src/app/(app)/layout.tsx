import { AppShell } from "@/components/app-shell";
import { Providers } from "@/components/providers";
import { requireSession } from "@/lib/dal";
import type { SessionInfo } from "@/lib/types";

/**
 * Server-side gate for every authenticated page. Runs before the page is streamed,
 * so an unauthenticated visitor is redirected to /login immediately — there is no
 * client-side wait and no way to end up stuck on a spinner.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  return (
    <Providers initialSession={session}>
      <AppShell>{children}</AppShell>
    </Providers>
  );
}

export type { SessionInfo };