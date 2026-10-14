"use client";

import {
  Activity,
  Clock,
  FolderKanban,
  Gauge,
  LayoutList,
  LogOut,
  Menu,
  ShieldCheck,
  Tags,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { TimerBar } from "@/components/timer-bar";
import { Avatar, displayName } from "@/components/avatar";
import { AssignmentBanner, NotificationBell } from "@/components/notifications";
import { Button } from "@/components/ui/button";
import { Dialog, Field, Input } from "@/components/ui/form";
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
  const [profileOpen, setProfileOpen] = useState(false);

  const items: NavItem[] = [
    { href: "/", label: "Dashboard", icon: Gauge, show: true },
    { href: "/my-tasks", label: "My Tasks", icon: LayoutList, show: true },
    { href: "/team-tasks", label: "Team Tasks", icon: FolderKanban, show: !!capabilities?.can_view_team },
    { href: "/time", label: "Tracked Time", icon: Clock, show: true },
    { href: "/activity", label: "Task Activity", icon: Activity, show: true },
    { href: "/workspace", label: "Workspace", icon: FolderKanban, show: true },
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

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex min-h-14 max-w-7xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <Link href="/" className="flex shrink-0 items-center gap-2 font-semibold">
            <ShieldCheck className="h-5 w-5 text-primary" aria-hidden />
            <span className="hidden sm:inline">MarketingOS</span>
          </Link>
          <nav className="ml-4 hidden min-w-0 flex-wrap items-center gap-1 lg:flex xl:ml-6">
            {items.map((item) => (
              <NavLink key={item.href} item={item} pathname={pathname} />
            ))}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <NotificationBell />
            {user ? (
              <button
                type="button"
                onClick={() => setProfileOpen(true)}
                className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 hover:bg-muted"
                title="Your profile"
              >
                <Avatar person={user} size="sm" />
                <span className="hidden text-sm sm:inline">{displayName(user)}</span>
              </button>
            ) : null}
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

      <AssignmentBanner />

      {user ? (
        <ProfileDialog user={user} open={profileOpen} onClose={() => setProfileOpen(false)} />
      ) : null}

      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-foreground/40" onClick={() => setDrawerOpen(false)} />
          <nav className="absolute inset-y-0 left-0 w-64 overflow-y-auto border-r border-border bg-card p-3">
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
        "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
        active ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-secondary",
        className,
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
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}