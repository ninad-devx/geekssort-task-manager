export type Role = "ceo" | "team_lead" | "member";
export type TaskStatus = "todo" | "in_progress" | "blocked" | "in_review" | "completed";
export type Priority = "low" | "medium" | "high" | "urgent";

export interface User {
  id: number;
  email: string;
  full_name: string;
  display_name: string | null;
  avatar_url: string | null;
  avatar_color: string | null;
  role: Role;
  is_admin: boolean;
  can_review: boolean;
  is_active: boolean;
  must_change_password: boolean;
  created_at: string;
}

export interface Capabilities {
  can_create_tasks: boolean;
  can_view_team: boolean;
  can_view_executive_dashboard: boolean;
  can_view_lead_dashboard: boolean;
  can_manage_users: boolean;
  can_review: boolean;
  can_create_folders: boolean;
  can_add_links: boolean;
  can_edit_time: boolean;
}

export interface Notification {
  id: number;
  task_id: number;
  task_title: string;
  task_status: TaskStatus;
  actor_name: string;
  actor_id: number | null;
  created_at: string;
  is_new: boolean;
  is_reminder?: boolean;
  message?: string | null;
}

export interface NotificationList {
  items: Notification[];
  unread: number;
  server_time: string;
}

export interface PersonRef {
  id: number;
  full_name: string;
  display_name: string | null;
  avatar_url: string | null;
  avatar_color: string | null;
  role: Role;
}

export interface PersonTasks {
  user: PersonRef;
  open_count: number;
  overdue_count: number;
  blocked_count: number;
  tracked_seconds: number;
  tasks: Task[];
}

export interface TaskBoard {
  people: PersonTasks[];
  unassigned_count: number;
  unassigned: Task[];
}

export interface SessionInfo {
  user: User;
  capabilities: Capabilities;
  server_time: string;
  app_timezone: string;
}

export interface DirectoryEntry {
  id: number;
  full_name: string;
  display_name: string | null;
  avatar_url: string | null;
  avatar_color: string | null;
  role: Role;
  is_active: boolean;
}

export interface Actor {
  id: number;
  full_name: string;
  role: Role;
}

export interface RunningTimer {
  log_id: number;
  task_id: number;
  task_title: string;
  started_at: string;
  elapsed_seconds: number;
  is_stale: boolean;
  /** Who the timer belongs to. Without this a client cannot tell its own clock
   *  -- the only one it may pause -- from a colleague's. */
  user_id: number;
  user: Actor | null;
  is_mine: boolean;
}

export interface Task {
  id: number;
  title: string;
  description: string | null;
  category: string | null;
  status: TaskStatus;
  priority: Priority;
  progress_percent: number;
  due_date: string | null;
  estimated_minutes: number | null;
  expected_deliverable: string | null;
  evidence_url: string | null;
  requires_review: boolean;
  blocked_reason: string | null;
  assignee_id: number | null;
  assignee: Actor | null;
  created_by_id: number | null;
  created_by: Actor | null;
  completed_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  is_overdue: boolean;
  tracked_seconds: number;
  running: RunningTimer | null;
  /** Timers other people have open on this task. */
  other_runners: RunningTimer[];
  allowed_actions: string[];
  log_count: number;
}

export interface TaskList {
  items: Task[];
  total: number;
  page: number;
  page_size: number;
}

export interface TaskLog {
  id: number;
  task_id: number;
  user_id: number;
  user: Actor | null;
  entry_type: "work_session" | "note";
  source: "timer" | "manual";
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  note: string | null;
  progress_percent: number | null;
  evidence_url: string | null;
  edit_count: number;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
  allowed_actions: string[];
}

export interface AuditEvent {
  id: number;
  request_id: string;
  event_type: string;
  actor_id: number | null;
  actor_name: string;
  entity_type: string;
  entity_id: number;
  task_id: number | null;
  summary: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
  created_at: string;
}

export interface AuditList {
  items: AuditEvent[];
  total: number;
  page: number;
  page_size: number;
}

export interface WorkingNowRow {
  log_id: number;
  user: { id: number; full_name: string };
  task: { id: number; title: string };
  started_at: string;
  elapsed_seconds: number;
  is_stale: boolean;
}

export interface DashboardCounts {
  total: number;
  by_status: Record<TaskStatus, number>;
  open: number;
  overdue: number;
  due_today: number;
  completed_in_range: number;
  in_progress?: number;
  blocked?: number;
  tracked_seconds: number;
}

export interface DashboardPayload {
  server_time: string;
  app_timezone: string;
  range: { from: string; to: string };
  counts: DashboardCounts;
  working_now: WorkingNowRow[];
  members?: MemberLoad[];
  needs_attention?: { in_review: number; blocked: BlockedRow[] };
  carried_over?: CarriedRow[];
  attention?: {
    due_today: number;
    overdue: number;
    blocked: number;
    in_review: number;
  };
  daily?: { day: string; seconds: number }[];
  running?: RunningTimer | null;
  period?: string;
  period_label?: string;
  worklists?: {
    in_progress: WorklistRow[];
    completed: WorklistRow[];
    overdue: WorklistRow[];
    blocked: WorklistRow[];
  };
}

export interface WorklistRow {
  id: number;
  title: string;
  status: TaskStatus;
  due_date: string | null;
  is_overdue: boolean;
  assignee: PersonRef | null;
}

export interface MemberLoad {
  user: { id: number; full_name: string; role: Role };
  open_tasks: number;
  tracked_seconds: number;
}

export interface BlockedRow {
  id: number;
  title: string;
  blocked_reason: string | null;
  assignee: string | null;
}

export interface CarriedRow {
  id: number;
  title: string;
  status: TaskStatus;
  due_date: string | null;
  is_overdue: boolean;
}

export interface Folder {
  id: number;
  name: string;
  description: string | null;
  parent_id: number | null;
  visibility: "all" | "management";
  depth: number;
  created_at: string;
  link_count: number;
  child_count: number;
  allowed_actions: string[];
}

export interface ResourceLink {
  id: number;
  folder_id: number | null;
  folder_name: string | null;
  folder_visibility: "all" | "management" | null;
  task_id: number | null;
  title: string;
  url: string;
  description: string | null;
  tags: string[];
  created_by_id: number | null;
  created_by?: PersonRef | null;
  created_at: string;
  updated_at: string;
  allowed_actions: string[];
}

export interface CreatedUser extends User {
  temporary_password: string | null;
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  blocked: "Blocked",
  in_review: "In Review",
  completed: "Completed",
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

export const CATEGORY_LABELS: Record<string, string> = {
  content: "Content",
  social_media: "Social media",
  campaign: "Campaign",
  leads_outreach: "Leads & outreach",
  events: "Events",
  competitor_research: "Competitor research",
  company_resources: "Company resources",
  other: "Other",
};

export interface Category {
  slug: string;
  label: string;
  is_active: boolean;
  sort_order: number;
  task_count: number;
}

export const EVENT_LABELS: Record<string, string> = {
  "user.created": "User created",
  "user.updated": "User updated",
  "user.deactivated": "User deactivated",
  "user.reactivated": "User reactivated",
  "user.password_changed": "Password changed",
  "user.password_reset": "Password reset",
  "task.created": "Task created",
  "task.updated": "Task updated",
  "task.assigned": "Task assigned",
  "task.deleted": "Task deleted",
  "task.restored": "Task restored",
  "task.status_changed": "Status changed",
  "task.review_requested": "Review requested",
  "task.approved": "Approved",
  "task.revision_requested": "Revision requested",
  "task.reopened": "Reopened",
  "timer.started": "Timer started",
  "timer.paused": "Timer paused",
  "log.manual_added": "Time added manually",
  "log.note_added": "Note added",
  "log.edited": "Time entry edited",
  "log.deleted": "Time entry deleted",
  "folder.created": "Folder created",
  "folder.updated": "Folder updated",
  "folder.moved": "Folder moved",
  "folder.deleted": "Folder deleted",
  "link.created": "Link added",
  "link.updated": "Link updated",
  "link.deleted": "Link deleted",
};