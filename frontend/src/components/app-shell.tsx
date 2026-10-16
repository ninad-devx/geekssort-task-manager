"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Clock,
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  LayoutList,
  LogOut,
  Menu,
  Search,
  Settings,
  ShieldCheck,
  Tags,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { TimerBar, useElapsed, useRunningTimer } from "@/components/timer-bar";
import { Avatar, displayName } from "@/components/avatar";
import { AssignmentBanner, NotificationBell } from "@/components/notifications";
import { Button } from "@/components/ui/button";
import { Dialog, Field, Input } from "@/components/ui/form";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatClock } from "@/lib/format";
import type { DashboardPayload } from "@/lib/types";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  show: boolean;
  badge?: number;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, capabilities, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const mode = capabilities?.can_view_executive_dashboard ? "executive" : "personal";
  // Read cached or lightweight dashboard counts for the sidebar task badge
  const dashSummary = useQuery({
    queryKey: ["dashboard", mode, "week"],
    queryFn: () => api<DashboardPayload>(`/dashboard/${mode}?period=week`),
    staleTime: 60_000,
  });
  const openCount = dashSummary.data?.counts.open;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        // Focus the topbar task search when Ctrl/Cmd+F is pressed unless inside an input
        const active = document.activeElement;
        if (
          active &&
          (active.tagName === "INPUT" ||
            active.tagName === "TEXTAREA" ||
            active.tagName === "SELECT")
        ) {
          return;
        }
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = searchText.trim();
    const targetBase = capabilities?.can_view_team ? "/team-tasks" : "/my-tasks";
    if (!trimmed) {
      router.push(targetBase);
      return;
    }
    router.push(`${targetBase}?q=${encodeURIComponent(trimmed)}`);
  };

  const menuItems: NavItem[] = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard, show: true },
    {
      href: "/my-tasks",
      label: "My Tasks",
      icon: LayoutList,
      show: true,
      badge: !capabilities?.can_view_team && openCount ? openCount : undefined,
    },
    {
      href: "/team-tasks",
      label: "Team Tasks",
      icon: FolderKanban,
      show: !!capabilities?.can_view_team,
      badge: capabilities?.can_view_team && openCount ? openCount : undefined,
    },
    { href: "/time", label: "Tracked Time", icon: Clock, show: true },
    { href: "/activity", label: "Task Activity", icon: Activity, show: true },
    { href: "/workspace", label: "Workspace", icon: FolderKanban, show: true },
  ].filter((item) => item.show);

  const adminItems: NavItem[] = [
    { href: "/users", label: "Users", icon: Users, show: !!capabilities?.can_manage_users },
    {
      href: "/categories",
      label: "Categories",
      icon: Tags,
      show: !!capabilities?.can_manage_users,
    },
    {
      href: "/permissions",
      label: "Permissions",
      icon: ShieldCheck,
      show: !!capabilities?.can_manage_users,
    },
  ].filter((item) => item.show);

  const sidebarContent = (onNavigate?: () => void) => (
    <div className="flex h-full flex-col justify-between">
      <div>
        <Link
          href="/"
          onClick={onNavigate}
          className="flex items-center gap-2.5 px-3 py-2 text-lg font-bold tracking-tight text-foreground"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt="Taskssort logo"
            className="h-9 w-9 shrink-0 rounded-full object-contain"
          />
          <span>Taskssort</span>
        </Link>

        <div className="mt-7">
          <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
            Menu
          </p>
          <nav aria-label="Main navigation" className="mt-2.5 flex flex-col gap-1">
            {menuItems.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                pathname={pathname}
                onNavigate={onNavigate}
              />
            ))}
          </nav>
        </div>

        <div className="mt-7">
          <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
            General
          </p>
          <nav aria-label="General navigation" className="mt-2.5 flex flex-col gap-1">
            {adminItems.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                pathname={pathname}
                onNavigate={onNavigate}
              />
            ))}
            <button
              type="button"
              onClick={() => {
                onNavigate?.();
                setProfileOpen(true);
              }}
              className="group relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-white/70 hover:text-foreground"
            >
              <Settings className="h-[18px] w-[18px] shrink-0 text-muted-foreground group-hover:text-[#145338]" aria-hidden />
              <span>Profile Settings</span>
            </button>
            <Link
              href="/change-password"
              onClick={onNavigate}
              className={cn(
                "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                pathname.startsWith("/change-password")
                  ? "bg-white font-semibold text-foreground shadow-2xs"
                  : "text-muted-foreground hover:bg-white/70 hover:text-foreground",
              )}
            >
              <KeyRound
                className={cn(
                  "h-[18px] w-[18px] shrink-0",
                  pathname.startsWith("/change-password")
                    ? "text-[#145338]"
                    : "text-muted-foreground group-hover:text-[#145338]",
                )}
                aria-hidden
              />
              <span>Password</span>
            </Link>
            <button
              type="button"
              onClick={() => {
                onNavigate?.();
                void logout();
              }}
              className="group relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-[#fdecee]/60 hover:text-destructive"
            >
              <LogOut className="h-[18px] w-[18px] shrink-0 text-muted-foreground group-hover:text-destructive" aria-hidden />
              <span>Logout</span>
            </button>
          </nav>
        </div>
      </div>

      <SidebarTimerCard onNavigate={onNavigate} />
    </div>
  );

  return (
    <div className="min-h-screen w-full bg-[#eceef0]/60 p-0 sm:p-2.5 lg:p-3.5">
      <div className="flex min-h-[calc(100vh-1.75rem)] w-full gap-3.5">
        {/* Desktop Sidebar */}
        <aside className="sticky top-3.5 hidden h-[calc(100vh-1.75rem)] w-64 shrink-0 flex-col overflow-y-auto rounded-3xl border border-white/80 bg-[#f7f8f9] p-5 shadow-[0_2px_12px_rgba(0,0,0,0.02)] lg:flex">
          {sidebarContent()}
        </aside>

        {/* Main Column */}
        <div className="flex min-w-0 flex-1 flex-col gap-3.5">
          {/* Topbar */}
          <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 rounded-none border-b border-border bg-[#f7f8f9]/95 px-4 py-3 backdrop-blur sm:top-2.5 sm:rounded-3xl sm:border sm:border-white/80 sm:px-6 sm:py-3.5 sm:shadow-[0_2px_12px_rgba(0,0,0,0.02)] lg:top-3.5">
            <div className="flex flex-1 items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden"
                onClick={() => setDrawerOpen(true)}
                aria-label="Open navigation"
              >
                <Menu className="h-5 w-5" />
              </Button>

              <form onSubmit={handleSearchSubmit} className="relative flex-1 max-w-md">
                <Search
                  className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <input
                  ref={searchInputRef}
                  type="search"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder="Search task"
                  aria-label="Search task"
                  className="h-10 w-full rounded-full border border-border/60 bg-white pl-10 pr-14 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#145338] focus:outline-none focus:ring-2 focus:ring-[#145338]/15"
                />
                <kbd
                  aria-hidden
                  className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-md border border-border bg-[#f5f6f7] px-1.5 py-0.5 font-sans text-[11px] font-medium text-muted-foreground sm:inline-flex"
                >
                  ⌘F
                </kbd>
              </form>
            </div>

            <div className="flex shrink-0 items-center gap-2.5 sm:gap-3">
              <NotificationBell />
              {user ? (
                <button
                  type="button"
                  onClick={() => setProfileOpen(true)}
                  className="flex items-center gap-2.5 rounded-full py-1 pl-1 pr-2 text-left transition-colors hover:bg-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title="Your profile"
                >
                  <Avatar person={user} size="md" />
                  <div className="hidden min-w-0 flex-col sm:flex">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold leading-tight text-foreground">
                        {displayName(user)}
                      </span>
                      <span className="rounded-full bg-[#eaf4ef] px-2 py-0.5 text-[10px] font-semibold text-[#145338]">
                        {roleLabel(user.role)}
                      </span>
                    </div>
                    <span className="truncate text-xs leading-tight text-muted-foreground">
                      {user.email}
                    </span>
                  </div>
                </button>
              ) : null}
            </div>
          </header>

          {/* Main Content Container */}
          <main className="flex-1 rounded-none bg-[#f7f8f9] px-4 py-5 sm:rounded-3xl sm:border sm:border-white/80 sm:px-7 sm:py-6 sm:shadow-[0_2px_12px_rgba(0,0,0,0.02)]">
            <AssignmentBanner />
            {children}
          </main>

          <TimerBar />
        </div>
      </div>

      {user ? (
        <ProfileDialog user={user} open={profileOpen} onClose={() => setProfileOpen(false)} />
      ) : null}

      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-foreground/40 backdrop-blur-xs"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-72 overflow-y-auto border-r border-border bg-[#f7f8f9] p-4 shadow-xl">
            {sidebarContent(() => setDrawerOpen(false))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SidebarTimerCard({ onNavigate }: { onNavigate?: () => void }) {
  const { data } = useRunningTimer();
  const running = data?.running?.[0];
  const elapsed = useElapsed(running?.started_at, data?.server_time);

  return (
    <div className="mt-6 overflow-hidden rounded-2xl p-4 time-tracker-card shadow-sm">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/15 text-white">
          <Clock className="h-3.5 w-3.5" aria-hidden />
        </span>
        <span className="text-xs font-medium text-white/85">Time Tracker</span>
      </div>
      {running ? (
        <>
          <p className="mt-2.5 truncate text-xs font-medium text-white/90" title={running.task_title}>
            {running.task_title}
          </p>
          <p className="mt-1 tabular text-xl font-bold tracking-tight text-white">
            {formatClock(elapsed)}
          </p>
          <Link
            href={`/tasks/${running.task_id}`}
            onClick={onNavigate}
            className="mt-3 flex w-full items-center justify-center rounded-full bg-[#1f7a52] py-2 text-xs font-semibold text-white transition-colors hover:bg-[#259062]"
          >
            Open Active Task
          </Link>
        </>
      ) : (
        <>
          <p className="mt-2.5 text-sm font-semibold leading-snug text-white">
            Track your work sessions
          </p>
          <p className="mt-1 text-[11px] text-white/70">
            Start a timer on any task to log live hours
          </p>
          <Link
            href="/time"
            onClick={onNavigate}
            className="mt-3.5 flex w-full items-center justify-center rounded-full bg-[#1f7a52] py-2 text-xs font-semibold text-white transition-colors hover:bg-[#259062]"
          >
            View Time Log
          </Link>
        </>
      )}
    </div>
  );
}

function NavLink({
  item,
  pathname,
  onNavigate,
  className,
}: {
  item: NavItem;
  pathname: string;
  onNavigate?: () => void;
  className?: string;
}) {
  const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all",
        active
          ? "bg-white font-semibold text-foreground shadow-2xs"
          : "font-medium text-muted-foreground hover:bg-white/70 hover:text-foreground",
        className,
      )}
    >
      {active ? (
        <span
          aria-hidden
          className="absolute -left-4 top-1.5 bottom-1.5 w-1.5 rounded-r-full bg-[#145338]"
        />
      ) : null}
      <Icon
        className={cn(
          "h-[18px] w-[18px] shrink-0 transition-colors",
          active ? "text-[#145338]" : "text-muted-foreground group-hover:text-[#145338]",
        )}
        aria-hidden
      />
      <span className="truncate">{item.label}</span>
      {item.badge !== undefined && item.badge > 0 ? (
        <span className="ml-auto rounded-md bg-[#145338] px-1.5 py-0.5 text-[10px] font-semibold text-white tabular">
          {item.badge}
        </span>
      ) : null}
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

const AVATAR_COLORS = [
  "#0ea5e9",
  "#8b5cf6",
  "#ec4899",
  "#f97316",
  "#10b981",
  "#eab308",
  "#6366f1",
  "#ef4444",
];

function ProfileDialog({
  user,
  open,
  onClose,
}: {
  user: NonNullable<ReturnType<typeof useAuth>["user"]>;
  open: boolean;
  onClose: () => void;
}) {
  const { updateProfile } = useAuth();
  const [display, setDisplay] = useState(user.display_name ?? "");
  const [url, setUrl] = useState(user.avatar_url ?? "");
  const [color, setColor] = useState(user.avatar_color ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateProfile({
        display_name: display.trim() || null,
        avatar_url: url.trim() || null,
        avatar_color: color || null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your profile");
    } finally {
      setBusy(false);
    }
  };

  const preview = {
    id: user.id,
    full_name: user.full_name,
    display_name: display.trim() || null,
    avatar_url: url.trim() || null,
    avatar_color: color || null,
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Your profile"
      description="How you appear to the rest of the team."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Avatar person={preview} size="md" />
          <span className="text-sm text-muted-foreground">{user.email}</span>
        </div>

        <Field label="Display name" hint="Leave blank to use your full name">
          <Input value={display} onChange={(e) => setDisplay(e.target.value)} maxLength={200} />
        </Field>

        <Field label="Picture URL" hint="Must be an http(s) link to an image">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </Field>

        <Field label="Fallback colour" hint="Used when you have no picture">
          <div className="flex flex-wrap gap-2">
            {AVATAR_COLORS.map((swatch) => (
              <button
                key={swatch}
                type="button"
                aria-label={`Use ${swatch}`}
                onClick={() => setColor(swatch === color ? "" : swatch)}
                className={cn(
                  "h-7 w-7 rounded-full border-2",
                  color === swatch ? "border-foreground" : "border-transparent",
                )}
                style={{ backgroundColor: swatch }}
              />
            ))}
          </div>
        </Field>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </Dialog>
  );
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
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2.5">{actions}</div> : null}
    </div>
  );
}