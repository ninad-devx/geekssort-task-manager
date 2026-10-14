import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="text-xl font-semibold">We could not find that page</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        The link may be wrong, or the item may have been deleted. If a task is not visible to you,
        it is reported as missing on purpose so IDs cannot be guessed.
      </p>
      <Link
        href="/"
        className="mt-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
      >
        Back to the dashboard
      </Link>
    </div>
  );
}
