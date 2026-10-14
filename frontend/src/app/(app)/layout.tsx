"use client";

import { ProtectedShell } from "@/components/protected-shell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <ProtectedShell>{children}</ProtectedShell>;
}