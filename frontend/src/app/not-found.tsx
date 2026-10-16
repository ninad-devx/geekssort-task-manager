import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#ebedef] px-4 text-center">
      <div className="max-w-md rounded-2xl border border-border/70 bg-card p-8 shadow-sm">
        <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">404 Not Found</p>
        <h1 className="mt-1 text-xl font-bold tracking-tight">We could not find that page</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The link may be wrong, or the item may have been deleted. If a task is not visible to you,
          it is reported as missing on purpose so IDs cannot be guessed.
        </p>
        <Link
          href="/"
          className="mt-5 inline-flex items-center justify-center rounded-full bg-gradient-to-b from-[#145338] to-[#1f7a52] px-5 py-2.5 text-sm font-medium text-white shadow-xs transition hover:brightness-105"
        >
          Back to the dashboard
        </Link>
      </div>
    </div>
  );
}
