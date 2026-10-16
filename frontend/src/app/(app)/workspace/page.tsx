"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  Link2,
  Lock,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Tag,
  Trash2,
  ArrowUpRight,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/app-shell";
import { Avatar, displayName } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, ErrorState, Spinner } from "@/components/ui/card";
import {
  Badge,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  Select,
  Textarea,
} from "@/components/ui/form";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatReadable } from "@/lib/format";
import type { Folder as FolderType, ResourceLink } from "@/lib/types";
import { cn } from "@/lib/utils";

interface SearchResult {
  query: string;
  folders: FolderType[];
  links: ResourceLink[];
}

export default function WorkspacePage() {
  const { capabilities } = useAuth();
  const client = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<null | "folder" | "link">(null);
  const [editingFolder, setEditingFolder] = useState<FolderType | null>(null);
  const [editingLink, setEditingLink] = useState<ResourceLink | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<FolderType | null>(null);
  const [deletingLink, setDeletingLink] = useState<ResourceLink | null>(null);

  const folders = useQuery({
    queryKey: ["workspace", "folders"],
    queryFn: () => api<FolderType[]>("/workspace/folders"),
  });

  const links = useQuery({
    queryKey: ["workspace", "links", selected],
    queryFn: () => api<ResourceLink[]>(`/workspace/links${selected ? `?folder_id=${selected}` : ""}`),
  });

  const search = useQuery({
    queryKey: ["workspace", "search", query],
    queryFn: () => api<SearchResult>(`/workspace/search?q=${encodeURIComponent(query)}`),
    enabled: query.trim().length >= 2,
  });

  const invalidate = () => client.invalidateQueries({ queryKey: ["workspace"] });

  const deleteFolder = useMutation({
    mutationFn: (folder: FolderType) => api(`/workspace/folders/${folder.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      toast.success("Folder deleted");
      setDeletingFolder(null);
      setSelected(null);
      await invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : "Could not delete the folder");
      setDeletingFolder(null);
    },
  });

  const deleteLink = useMutation({
    mutationFn: (link: ResourceLink) => api(`/workspace/links/${link.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      toast.success("Link deleted");
      setDeletingLink(null);
      await invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : "Could not delete the link");
      setDeletingLink(null);
    },
  });

  const allFolders = folders.data ?? [];
  const currentLinks = links.data ?? [];
  const tree = buildTree(allFolders);
  const showSearch = query.trim().length >= 2;
  const totalFolderLinks = allFolders.reduce((sum, f) => sum + f.link_count, 0);
  const uniqueTags = new Set(currentLinks.flatMap((l) => l.tags)).size;
  const selectedFolder = allFolders.find((f) => f.id === selected) ?? null;

  return (
    <>
      <PageHeader
        title="Marketing Workspace"
        description="Curated folders of reference links — research, brand assets, competitor intelligence, and past campaigns."
        actions={
          <>
            {capabilities?.can_create_folders ? (
              <Button variant="outline" onClick={() => setDialog("folder")}>
                <FolderPlus className="h-4 w-4" aria-hidden />
                New Folder
              </Button>
            ) : null}
            {capabilities?.can_add_links ? (
              <Button onClick={() => setDialog("link")}>
                <Plus className="h-4 w-4" aria-hidden />
                Add Link
              </Button>
            ) : null}
          </>
        }
      />

      {/* Workspace Summary KPI Strip */}
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <div className="flex items-center justify-between rounded-2xl p-5 hero-green-card shadow-[0_8px_24px_rgba(20,83,56,0.18)]">
          <div>
            <p className="text-xs font-medium text-white/85">Active View</p>
            <p className="mt-1 truncate text-xl font-bold text-white">
              {selectedFolder ? selectedFolder.name : "All Workspace Links"}
            </p>
            <p className="mt-1 text-xs text-[#a9dfc2]">
              {currentLinks.length} resource{currentLinks.length === 1 ? "" : "s"} in current view
            </p>
          </div>
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-white">
            <Link2 className="h-5 w-5" aria-hidden />
          </span>
        </div>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Workspace Folders</p>
            <p className="mt-1 tabular text-3xl font-bold tracking-tight text-foreground">
              {allFolders.length}
            </p>
            <p className="mt-1 text-xs text-[#1f7a52]">
              {totalFolderLinks} categorized link{totalFolderLinks === 1 ? "" : "s"}
            </p>
          </div>
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#145338]">
            <FolderOpen className="h-5 w-5" aria-hidden />
          </span>
        </Card>

        <Card className="flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Active Tags in View</p>
            <p className="mt-1 tabular text-3xl font-bold tracking-tight text-foreground">
              {uniqueTags}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Searchable by title, folder, or tag
            </p>
          </div>
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#eaf4ef] text-[#145338]">
            <Tag className="h-5 w-5" aria-hidden />
          </span>
        </Card>
      </div>

      {/* Search Bar */}
      <Card className="mb-5 p-3">
        <div className="relative flex items-center">
          <Search
            className="pointer-events-none absolute left-3.5 h-4 w-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            className="h-10 rounded-full border-border/60 bg-[#f7f8f9] pl-10 pr-4"
            placeholder="Search folders, links, descriptions, or tags…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <Button
              variant="ghost"
              size="sm"
              className="ml-2"
              onClick={() => setQuery("")}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </Card>

      {showSearch ? (
        <SearchResults
          result={search.data}
          isLoading={search.isLoading}
          onSelectFolder={(id) => {
            setSelected(id);
            setQuery("");
          }}
          onEditLink={(link) => {
            setEditingLink(link);
            setDialog("link");
          }}
          onDeleteLink={setDeletingLink}
        />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
          {/* Left Folder Explorer Card */}
          <Card className="h-fit overflow-hidden">
            <div className="flex items-center justify-between border-b border-border/70 bg-muted/30 px-4 py-3.5">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Folders
              </span>
              {capabilities?.can_create_folders ? (
                <button
                  type="button"
                  onClick={() => setDialog("folder")}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[#145338] hover:underline"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  New
                </button>
              ) : null}
            </div>

            <div className="p-2.5">
              <button
                type="button"
                onClick={() => setSelected(null)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm transition-all",
                  selected === null
                    ? "bg-[#eaf4ef] font-semibold text-[#145338]"
                    : "font-medium text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                )}
              >
                <Sparkles className="h-4 w-4 shrink-0" aria-hidden />
                <span className="flex-1 truncate">All Folders</span>
              </button>

              {folders.isLoading ? (
                <Spinner />
              ) : folders.isError ? (
                <div className="p-3">
                  <ErrorState
                    message="Could not load folders."
                    onRetry={() => void folders.refetch()}
                  />
                </div>
              ) : tree.length === 0 ? (
                <p className="p-4 text-xs leading-relaxed text-muted-foreground">
                  No folders yet. Run <code>python -m app.cli seed-defaults</code> to create the
                  standard set.
                </p>
              ) : (
                <ul className="mt-1.5 space-y-0.5">
                  {tree.map((node) => (
                    <FolderNode
                      key={node.folder.id}
                      node={node}
                      depth={0}
                      selected={selected}
                      onSelect={setSelected}
                    />
                  ))}
                </ul>
              )}
            </div>
          </Card>

          {/* Right Links Content Area */}
          <div className="flex flex-col gap-4">
            {selectedFolder ? (
              <FolderToolbar
                folder={selectedFolder}
                onEdit={(folder) => {
                  setEditingFolder(folder);
                  setDialog("folder");
                }}
                onDelete={setDeletingFolder}
              />
            ) : null}

            {links.isLoading ? (
              <Spinner label="Loading links" />
            ) : currentLinks.length === 0 ? (
              <EmptyState
                title="No links here yet"
                description="Add a reference link so the whole team can find it again."
                action={
                  capabilities?.can_add_links ? (
                    <Button className="mt-2" onClick={() => setDialog("link")}>
                      <Plus className="h-4 w-4" aria-hidden />
                      Add first link
                    </Button>
                  ) : null
                }
              />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {currentLinks.map((link) => (
                  <LinkCard
                    key={link.id}
                    link={link}
                    onEdit={() => {
                      setEditingLink(link);
                      setDialog("link");
                    }}
                    onDelete={() => setDeletingLink(link)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {dialog === "folder" ? (
        <FolderDialog
          open
          folder={editingFolder}
          folders={allFolders}
          onClose={() => {
            setDialog(null);
            setEditingFolder(null);
          }}
          onDone={invalidate}
        />
      ) : null}
      {dialog === "link" ? (
        <LinkDialog
          open
          link={editingLink}
          folders={allFolders}
          defaultFolderId={selected}
          onClose={() => {
            setDialog(null);
            setEditingLink(null);
          }}
          onDone={invalidate}
        />
      ) : null}
      <ConfirmDialog
        open={deletingFolder !== null}
        onClose={() => setDeletingFolder(null)}
        destructive
        confirmLabel="Delete folder"
        title={`Delete “${deletingFolder?.name ?? ""}”?`}
        description="The folder must be empty. This cannot be undone."
        loading={deleteFolder.isPending}
        onConfirm={() => deletingFolder && deleteFolder.mutate(deletingFolder)}
      />
      <ConfirmDialog
        open={deletingLink !== null}
        onClose={() => setDeletingLink(null)}
        destructive
        confirmLabel="Delete link"
        title={`Delete “${deletingLink?.title ?? ""}”?`}
        description="The link is soft-deleted and recorded in the audit history."
        loading={deleteLink.isPending}
        onConfirm={() => deletingLink && deleteLink.mutate(deletingLink)}
      />
    </>
  );
}

interface FolderNodeData {
  folder: FolderType;
  children: FolderNodeData[];
}

function buildTree(folders: FolderType[]): FolderNodeData[] {
  const byParent = new Map<number | null, FolderType[]>();
  for (const folder of folders) {
    const list = byParent.get(folder.parent_id) ?? [];
    list.push(folder);
    byParent.set(folder.parent_id, list);
  }
  const build = (parentId: number | null): FolderNodeData[] =>
    (byParent.get(parentId) ?? [])
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((folder) => ({ folder, children: build(folder.id) }));
  return build(null);
}

function FolderNode({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: FolderNodeData;
  depth: number;
  selected: number | null;
  onSelect: (id: number) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const isSelected = selected === node.folder.id;

  return (
    <li>
      <div
        className={cn(
          "flex items-center gap-1.5 rounded-xl pr-2.5 transition-colors",
          isSelected
            ? "bg-[#eaf4ef] text-[#145338]"
            : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="px-1 py-2 text-xs text-muted-foreground"
          aria-label={open ? "Collapse" : "Expand"}
        >
          {node.children.length > 0 ? (open ? "▾" : "▸") : "·"}
        </button>
        {isSelected ? (
          <FolderOpen className="h-4 w-4 shrink-0 text-[#145338]" aria-hidden />
        ) : (
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <button
          type="button"
          onClick={() => onSelect(node.folder.id)}
          className={cn(
            "min-w-0 flex-1 truncate py-2 text-left text-sm",
            isSelected ? "font-semibold text-[#145338]" : "font-medium",
          )}
        >
          {node.folder.name}
        </button>
        {node.folder.visibility === "management" ? (
          <Badge variant="warning" title="Management only">
            <Lock className="h-2.5 w-2.5" aria-hidden />
            Lead
          </Badge>
        ) : null}
        <span
          className={cn(
            "rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular",
            isSelected
              ? "bg-[#145338] text-white"
              : "bg-muted text-muted-foreground",
          )}
        >
          {node.folder.link_count}
        </span>
      </div>
      {open && node.children.length > 0 ? (
        <ul className="mt-0.5 space-y-0.5">
          {node.children.map((child) => (
            <FolderNode
              key={child.folder.id}
              node={child}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function FolderToolbar({
  folder,
  onEdit,
  onDelete,
}: {
  folder: FolderType | null;
  onEdit: (folder: FolderType) => void;
  onDelete: (folder: FolderType) => void;
}) {
  if (!folder) return null;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#eaf4ef] text-[#145338]">
          <FolderOpen className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold text-foreground">{folder.name}</h2>
            <Badge variant="default">{folder.link_count} links</Badge>
            {folder.visibility === "management" ? (
              <Badge variant="warning">Management only</Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {folder.description ? `${folder.description} · ` : ""}
            Created {formatDateTime(folder.created_at)}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {folder.allowed_actions.includes("edit") ? (
            <Button variant="outline" size="sm" onClick={() => onEdit(folder)}>
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Rename
            </Button>
          ) : null}
          {folder.allowed_actions.includes("delete") ? (
            <Button variant="ghost" size="sm" onClick={() => onDelete(folder)}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
              Delete
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function getHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function LinkCard({
  link,
  onEdit,
  onDelete,
}: {
  link: ResourceLink;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const host = getHostname(link.url);

  return (
    <Card className="group flex flex-col justify-between p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-[#145338]/40">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#eaf4ef] text-[#145338]">
              <Globe className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="block truncate text-sm font-bold text-foreground group-hover:text-[#145338] hover:underline"
              >
                {link.title}
              </a>
              <span className="block truncate text-[11px] text-muted-foreground">
                {host}
              </span>
            </div>
          </div>

          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            aria-label={`Open ${link.title}`}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors group-hover:border-[#145338] group-hover:bg-[#145338] group-hover:text-white"
          >
            <ArrowUpRight className="h-4 w-4" aria-hidden />
          </a>
        </div>

        {link.description ? (
          <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {link.description}
          </p>
        ) : null}

        {link.tags.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {link.tags.map((tag) => (
              <Badge key={tag} variant="default">
                #{tag}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-3">
        {link.created_by ? (
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <Avatar person={link.created_by} size="xs" />
            <span className="truncate font-medium text-foreground/80">
              {displayName(link.created_by)}
            </span>
            <span aria-hidden>·</span>
            <time dateTime={link.created_at} className="whitespace-nowrap text-[11px]">
              {formatReadable(link.created_at)}
            </time>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Workspace resource</span>
        )}

        {link.allowed_actions.length > 0 ? (
          <div className="flex shrink-0 items-center gap-1">
            {link.allowed_actions.includes("edit") ? (
              <Button variant="ghost" size="sm" onClick={onEdit} aria-label="Edit link">
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              </Button>
            ) : null}
            {link.allowed_actions.includes("delete") ? (
              <Button variant="ghost" size="sm" onClick={onDelete} aria-label="Delete link">
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function SearchResults({
  result,
  isLoading,
  onSelectFolder,
  onEditLink,
  onDeleteLink,
}: {
  result?: SearchResult;
  isLoading: boolean;
  onSelectFolder: (id: number) => void;
  onEditLink: (link: ResourceLink) => void;
  onDeleteLink: (link: ResourceLink) => void;
}) {
  if (isLoading) return <Spinner label="Searching" />;
  if (!result || (result.folders.length === 0 && result.links.length === 0)) {
    return <EmptyState title="No matches" description="Try a different word." />;
  }
  return (
    <div className="flex flex-col gap-5">
      {result.folders.length > 0 ? (
        <div>
          <h2 className="mb-2.5 text-sm font-semibold">Matching Folders</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {result.folders.map((folder) => (
              <Card
                key={folder.id}
                className="cursor-pointer p-4 transition-colors hover:border-[#145338]/40"
                onClick={() => onSelectFolder(folder.id)}
              >
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#eaf4ef] text-[#145338]">
                    <Folder className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="font-semibold">{folder.name}</span>
                  {folder.visibility === "management" ? (
                    <Badge variant="warning" className="ml-auto">
                      Management only
                    </Badge>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
        </div>
      ) : null}
      {result.links.length > 0 ? (
        <div>
          <h2 className="mb-2.5 text-sm font-semibold">Matching Links</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {result.links.map((link) => (
              <LinkCard
                key={link.id}
                link={link}
                onEdit={() => onEditLink(link)}
                onDelete={() => onDeleteLink(link)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FolderDialog({
  open,
  folder,
  folders,
  onClose,
  onDone,
}: {
  open: boolean;
  folder: FolderType | null;
  folders: FolderType[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(folder?.name ?? "");
  const [description, setDescription] = useState(folder?.description ?? "");
  const [parentId, setParentId] = useState("");
  const [visibility, setVisibility] = useState<"all" | "management">(
    folder?.visibility ?? "all",
  );

  const mutation = useMutation({
    mutationFn: () =>
      folder
        ? api(`/workspace/folders/${folder.id}`, {
            method: "PATCH",
            json: {
              name: name || folder.name,
              description: description || null,
              visibility,
            },
          })
        : api("/workspace/folders", {
            method: "POST",
            json: {
              name,
              description: description || null,
              parent_id: parentId ? Number(parentId) : null,
              visibility,
            },
          }),
    onSuccess: async () => {
      toast.success(folder ? "Folder updated" : "Folder created");
      setName("");
      setDescription("");
      onClose();
      await onDone();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not save the folder"),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={folder ? "Edit folder" : "New folder"}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} loading={mutation.isPending} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Description" hint="Optional">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {!folder ? (
          <Field label="Parent folder" hint="Folders may be nested up to 6 deep.">
            <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">Top level</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {"— ".repeat(f.depth - 1)}
                  {f.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field
          label="Visibility"
          hint="Management-only folders are hidden from members, including their links."
        >
          <Select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as "all" | "management")}
          >
            <option value="all">Everyone</option>
            <option value="management">Management only</option>
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

function LinkDialog({
  open,
  link,
  folders,
  defaultFolderId,
  onClose,
  onDone,
}: {
  open: boolean;
  link: ResourceLink | null;
  folders: FolderType[];
  defaultFolderId: number | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(link?.title ?? "");
  const [url, setUrl] = useState(link?.url ?? "");
  const [description, setDescription] = useState(link?.description ?? "");
  const [folderId, setFolderId] = useState(
    link?.folder_id?.toString() ?? defaultFolderId?.toString() ?? "",
  );
  const [tags, setTags] = useState(link?.tags.join(", ") ?? "");

  const mutation = useMutation({
    mutationFn: () => {
      const body = {
        title: title.trim(),
        url: url.trim(),
        description: description || null,
        folder_id: folderId ? Number(folderId) : null,
        tags: tags
          .split(",")
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
      };
      return link
        ? api(`/workspace/links/${link.id}`, { method: "PATCH", json: body })
        : api("/workspace/links", { method: "POST", json: body });
    },
    onSuccess: async () => {
      toast.success(link ? "Link updated" : "Link added");
      setTitle("");
      setUrl("");
      setDescription("");
      setTags("");
      onClose();
      await onDone();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not save the link"),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={link ? "Edit link" : "Add a link"}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            loading={mutation.isPending}
            disabled={!title.trim() || !url.trim()}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <Field label="URL" hint="http and https only. The server never fetches it.">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2048} />
        </Field>
        <Field label="Folder">
          <Select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">No folder</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {"— ".repeat(f.depth - 1)}
                {f.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Tags" hint="Comma separated, up to 10.">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="brand, social media" />
        </Field>
        <Field label="Description" hint="Optional">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
        </Field>
      </div>
    </Dialog>
  );
}