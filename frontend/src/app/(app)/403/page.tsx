"use client";

import { ShieldAlert } from "lucide-react";
import Link from "next/link";

export default function Forbidden() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="max-w-md rounded-2xl border border-border/70 bg-card p-8 shadow-[0_1px_3px_rgba(15,23,42,0.03)]">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#145338]">
          <ShieldAlert className="h-6 w-6" aria-hidden />
        </div>
        <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">403 Forbidden</p>
        <h1 className="mt-1 text-xl font-bold tracking-tight">Not available for your role</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This area is restricted. If you need access, ask an administrator.
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
