"use client";

import Link from "next/link";

export default function Forbidden() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <p className="text-sm font-medium text-muted-foreground">403</p>
      <h1 className="text-xl font-semibold">Not available for your role</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        This area is restricted. If you need access, ask an administrator.
      </p>
      <Link href="/" className="mt-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
        Back to the dashboard
      </Link>
    </div>
  );
}
