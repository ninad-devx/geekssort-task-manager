"use client";

import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#ebedef] px-4 text-center">
      <div className="max-w-md rounded-2xl border border-border/70 bg-card p-8 shadow-sm">
        <h1 className="text-xl font-bold tracking-tight">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {error.message || "An unexpected error occurred."}
        </p>
        <div className="mt-5 flex justify-center gap-2.5">
          <Button onClick={reset}>Try again</Button>
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-full border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-secondary"
          >
            Back to the dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
