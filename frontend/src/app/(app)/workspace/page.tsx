"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FolderPlus, Link2, Pencil, Plus, Search, Trash2 } from "lucide-react";
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
import type { Folder, ResourceLink } from "@/lib/types";

interface SearchResult {
  query: string;
  folders: Folder[];
  links: ResourceLink[];
}

export default function WorkspacePage() {
  const { capabilities } = useAuth();
  const client = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<null | "folder" | "link">(null);
  const [editingFolder, setEditingFolder] = useState<Folder | null>(null);
  const [editingLink, setEditingLink] = useState<ResourceLink | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<Folder | null>(null);
  const [deletingLink, setDeletingLink] = useState<ResourceLink | null>(null);

  const folders = useQuery({
    queryKey: ["workspace", "folders"],
    queryFn: () => api<Folder[]>("/workspace/folders"),
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
    mutationFn: (folder: Folder) => api(`/workspace/folders/${folder.id}`, { method: "DELETE" }),
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

  const tree = buildTree(folders.data ?? []);
  const showSearch = query.trim().length >= 2;

  return (
    <>
      <PageHeader
        title="Marketing Workspace"
        description="Folders of links — research, brand references, past campaigns."
        actions={
          <>
            {capabilities?.can_create_folders ? (
              <Button variant="outline" onClick={() => setDialog("folder")}>
                <FolderPlus className="h-4 w-4" aria-hidden />
                New folder
              </Button>
            ) : null}
            {capabilities?.can_add_links ? (
              <Button onClick={() => setDialog("link")}>
                <Plus className="h-4 w-4" aria-hidden />
                Add link
              </Button>
            ) : null}
          </>
        }
      />

      <div className="relative mb-4 max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          className="pl-8"
          placeholder="Search folders, links, tags…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {showSearch ? (
        <SearchResults
          result={search.data}
          isLoading={search.isLoading}
          onEditLink={setEditingLink}
          onDeleteLink={setDeletingLink}
        />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
          <Card className="h-fit">
            <div className="border-b border-border p-3">
              <button
                type="button"
                onClick={() => setSelected(null)}
                className={`w-full rounded-md px-2 py-1.5 text-left text-sm ${
                  selected === null ? "bg-primary/10 font-medium text-primary" : "hover:bg-secondary"
                }`}
              >
                All folders
              </button>
            </div>
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
              <p className="p-4 text-sm text-muted-foreground">
                No folders yet. Run <code>python -m app.cli seed-defaults</code> to create the
                standard set.
              </p>
            ) : (
              <ul className="p-2">
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
          </Card>

          <div>
            {selected !== null ? (
              <FolderToolbar
                folder={(folders.data ?? []).find((f) => f.id === selected) ?? null}
                onEdit={setEditingFolder}
                onDelete={setDeletingFolder}
              />
            ) : null}
            {links.isLoading ? (
              <Spinner label="Loading links" />
            ) : (links.data ?? []).length === 0 ? (
              <EmptyState
                title="No links here yet"
                description="Add a reference link so the whole team can find it again."
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {(links.data ?? []).map((link) => (
                  <LinkCard
                    key={link.id}
                    link={link}
                    onEdit={() => setEditingLink(link)}
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
          folders={folders.data ?? []}
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
          folders={folders.data ?? []}
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
  folder: Folder;
  children: FolderNodeData[];
}

function buildTree(folders: Folder[]): FolderNodeData[] {
  const byParent = new Map<number | null, Folder[]>();
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
  return (
    <li>
      <div
        className={`flex items-center gap-1 rounded-md pr-2 ${
          selected === node.folder.id ? "bg-primary/10" : "hover:bg-secondary"
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="px-1 py-1.5 text-xs text-muted-foreground"
          aria-label={open ? "Collapse" : "Expand"}
        >
          {node.children.length > 0 ? (open ? "▾" : "▸") : "·"}
        </button>
        <button
          type="button"
          onClick={() => onSelect(node.folder.id)}
          className={`min-w-0 flex-1 truncate py-1.5 text-left text-sm ${
            selected === node.folder.id ? "font-medium text-primary" : ""
          }`}
        >
          {node.folder.name}
        </button>
        {node.folder.visibility === "management" ? <Badge variant="warning">Lead</Badge> : null}
        <span className="text-xs text-muted-foreground">{node.folder.link_count}</span>
      </div>
      {open && node.children.length > 0 ? (
        <ul>
          {node.children.map((child) => (
            <FolderNode key={child.folder.id} node={child} depth={depth + 1} selected={selected} onSelect={onSelect} />
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
  folder: Folder | null;
  onEdit: (folder: Folder) => void;
  onDelete: (folder: Folder) => void;
}) {
  if (!folder) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <h2 className="text-sm font-semibold">{folder.name}</h2>
      <Badge variant="outline">{folder.link_count} links</Badge>
      {folder.visibility === "management" ? <Badge variant="warning">Management only</Badge> : null}
      <span className="text-xs text-muted-foreground">
        Created {formatDateTime(folder.created_at)}
      </span>
      {folder.allowed_actions.includes("edit") ? (
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => onEdit(folder)}>
          <Pencil className="h-4 w-4" aria-hidden />
          Rename
        </Button>
      ) : null}
      {folder.allowed_actions.includes("delete") ? (
        <Button variant="ghost" size="sm" onClick={() => onDelete(folder)}>
          <Trash2 className="h-4 w-4" aria-hidden />
          Delete
        </Button>
      ) : null}
    </div>
  );
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
  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-start justify-between gap-2">
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="inline-flex items-center gap-1 font-medium hover:underline"
        >
          <Link2 className="h-4 w-4 shrink-0" aria-hidden />
          <span className="break-all">{link.title}</span>
          <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
        </a>
      </div>
      {link.description ? (
        <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">{link.description}</p>
      ) : null}
      {link.created_by ? (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Avatar person={link.created_by} size="xs" />
          <span className="truncate">Added by {displayName(link.created_by)}</span>
          <span aria-hidden>·</span>
          <time dateTime={link.created_at} className="whitespace-nowrap">
            {formatReadable(link.created_at)}
          </time>
        </div>
      ) : null}
      {link.tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {link.tags.map((tag) => (
            <Badge key={tag} variant="muted">
              {tag}
            </Badge>
          ))}
        </div>
      ) : null}
      {link.allowed_actions.length > 0 ? (
        <div className="mt-3 flex gap-1">
          {link.allowed_actions.includes("edit") ? (
            <Button variant="ghost" size="sm" onClick={onEdit}>
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Edit
            </Button>
          ) : null}
          {link.allowed_actions.includes("delete") ? (
            <Button variant="ghost" size="sm" onClick={onDelete}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
              Delete
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function SearchResults({
  result,
  isLoading,
  onEditLink,
  onDeleteLink,
}: {
  result?: SearchResult;
  isLoading: boolean;
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
          <h2 className="mb-2 text-sm font-semibold">Folders</h2>
          <Card>
            <ul>
              {result.folders.map((folder) => (
                <li key={folder.id} className="border-b border-border px-4 py-2.5 text-sm last:border-b-0">
                  {folder.name}
                  {folder.visibility === "management" ? (
                    <Badge variant="warning" className="ml-2">
                      Management only
                    </Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ) : null}
      {result.links.length > 0 ? (
        <div>
          <h2 className="mb-2 text-sm font-semibold">Links</h2>
          <div className="grid gap-3 sm:grid-cols-2">
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
  folder: Folder | null;
  folders: Folder[];
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
  folders: Folder[];
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