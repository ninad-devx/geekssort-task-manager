"use client";

import {
  Activity,
  FolderKanban,
  Gauge,
  LayoutList,
  LogOut,
  Menu,
  ShieldCheck,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { TimerBar } from "@/components/timer-bar";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: typeof Gauge;
  show: boolean;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, capabilities, logout } = useAuth();
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const items: NavItem[] = [
    { href: "/", label: "Dashboard", icon: Gauge, show: true },
    { href: "/my-tasks", label: "My Tasks", icon: LayoutList, show: true },
    { href: "/team-tasks", label: "Team Tasks", icon: FolderKanban, show: !!capabilities?.can_view_team },
    { href: "/activity", label: "Task Activity", icon: Activity, show: true },
    { href: "/workspace", label: "Workspace", icon: FolderKanban, show: true },
    { href: "/users", label: "Users", icon: Users, show: !!capabilities?.can_manage_users },
  ].filter((item) => item.show);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="h-5 w-5 text-primary" aria-hidden />
            MarketingOS
          </Link>
          <nav className="ml-6 hidden items-center gap-1 lg:flex">
            {items.map((item) => (
              <NavLink key={item.href} item={item} pathname={pathname} />
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden text-sm text-muted-foreground sm:inline">{user?.full_name}</span>
            <span className="hidden rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground sm:inline">
              {roleLabel(user?.role)}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void logout()}>
              <LogOut className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>

      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-foreground/40" onClick={() => setDrawerOpen(false)} />
          <nav className="absolute inset-y-0 left-0 w-64 border-r border-border bg-card p-3">
            <p className="px-2 py-1 text-xs font-medium text-muted-foreground">Navigation</p>
            {items.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                pathname={pathname}
                onNavigate={() => setDrawerOpen(false)}
              />
            ))}
          </nav>
        </div>
      ) : null}

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5">{children}</main>
      <TimerBar />
    </div>
  );
}

function NavLink({
  item,
  pathname,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  onNavigate?: () => void;
}) {
  const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
        active ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-secondary",
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
      {item.label}
    </Link>
  );
}

export function roleLabel(role: string | undefined): string {
  switch (role) {
    case "ceo":
      return "CEO";
    case "team_lead":
      return "Team Lead";
    default:
      return "Member";
  }
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}