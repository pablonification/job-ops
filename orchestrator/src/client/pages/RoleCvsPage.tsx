import * as api from "@client/api";
import { ConfirmDelete } from "@client/components/ConfirmDelete";
import {
  EmptyState,
  ListItem,
  ListPanel,
  PageHeader,
  PageMain,
  SectionCard,
} from "@client/components/layout";
import {
  type RoleCvBusyAction,
  RoleCvEditor,
  RoleCvStatusBadge,
} from "@client/components/role-cvs/RoleCvEditor";
import { useSettings } from "@client/hooks/useSettings";
import { showErrorToast } from "@client/lib/error-toast";
import { downloadRoleCvPdf, openRoleCvPdf } from "@client/lib/private-pdf";
import { queryKeys } from "@client/lib/queryKeys";
import { safePdfFileName } from "@shared/filename-sanitizer";
import type { RoleCv, UpdateRoleCvInput } from "@shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileStack, Plus } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const CreateRoleCvDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (roleCv: RoleCv) => void;
}> = ({ open, onOpenChange, onCreated }) => {
  const [name, setName] = useState("");
  const [roleDescription, setRoleDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setIsSubmitting(true);
    try {
      const created = await api.createRoleCv({
        name: name.trim(),
        roleDescription: roleDescription.trim(),
      });
      setName("");
      setRoleDescription("");
      onCreated(created);
    } catch (error) {
      showErrorToast(error, "Could not create the Role CV.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New Role CV</DialogTitle>
            <DialogDescription>
              Name a target role and describe it. You can generate the CV next.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="new-role-cv-name">Name</Label>
            <Input
              id="new-role-cv-name"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              placeholder="Backend Engineer"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-role-cv-description">Role description</Label>
            <Textarea
              id="new-role-cv-description"
              value={roleDescription}
              onChange={(event) => setRoleDescription(event.target.value)}
              placeholder="What this role does and what it needs."
              className="min-h-[120px]"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || isSubmitting}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export const RoleCvsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const { settings } = useSettings();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<RoleCvBusyAction>(null);

  const roleCvsQuery = useQuery({
    queryKey: queryKeys.roleCvs.list(),
    queryFn: api.getRoleCvs,
  });
  const catalogQuery = useQuery({
    queryKey: queryKeys.roleCvs.projectCatalog(),
    queryFn: api.getProfileProjects,
  });

  const roleCvs = roleCvsQuery.data ?? [];
  const selected =
    roleCvs.find((roleCv) => roleCv.id === selectedId) ?? roleCvs[0] ?? null;

  const replaceInCache = (roleCv: RoleCv) => {
    queryClient.setQueryData<RoleCv[]>(queryKeys.roleCvs.list(), (current) => {
      const list = current ?? [];
      const exists = list.some((item) => item.id === roleCv.id);
      return exists
        ? list.map((item) => (item.id === roleCv.id ? roleCv : item))
        : [roleCv, ...list];
    });
  };

  const runAction = async <T,>(
    action: Exclude<RoleCvBusyAction, null>,
    work: () => Promise<T>,
    fallbackError: string,
  ): Promise<T | null> => {
    setBusyAction(action);
    try {
      return await work();
    } catch (error) {
      showErrorToast(error, fallbackError);
      return null;
    } finally {
      setBusyAction(null);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.roleCvs.list(),
      });
    }
  };

  const saveChanges = async (roleCv: RoleCv, changes: UpdateRoleCvInput) => {
    const updated = await api.updateRoleCv(roleCv.id, changes);
    replaceInCache(updated);
    return updated;
  };

  const handleSave = async (changes: UpdateRoleCvInput) => {
    if (!selected) return;
    const updated = await runAction(
      "save",
      () => saveChanges(selected, changes),
      "Could not save the Role CV.",
    );
    if (updated) toast.success("Saved");
  };

  const handleGenerate = async (pendingChanges: UpdateRoleCvInput | null) => {
    if (!selected) return;
    const generated = await runAction(
      "generate",
      async () => {
        if (pendingChanges) await saveChanges(selected, pendingChanges);
        return api.generateRoleCv(selected.id);
      },
      "Could not generate the Role CV.",
    );
    if (generated) {
      replaceInCache(generated);
      toast.success("Role CV generated");
    }
  };

  const handleGeneratePdf = async (
    pendingChanges: UpdateRoleCvInput | null,
  ) => {
    if (!selected) return;
    const updated = await runAction(
      "pdf",
      async () => {
        if (pendingChanges) await saveChanges(selected, pendingChanges);
        return api.generateRoleCvPdf(selected.id);
      },
      "Could not make the PDF.",
    );
    if (updated) {
      replaceInCache(updated);
      toast.success("PDF ready");
    }
  };

  const handleOpenPdf = () => {
    if (!selected) return;
    void openRoleCvPdf(selected.id).catch((error: unknown) =>
      showErrorToast(error, "Could not open the PDF."),
    );
  };

  const handleDownloadPdf = () => {
    if (!selected) return;
    void downloadRoleCvPdf(
      selected.id,
      safePdfFileName(selected.name, { fallbackBase: "Role_CV" }),
    ).catch((error: unknown) =>
      showErrorToast(error, "Could not download the PDF."),
    );
  };

  const handleDelete = async () => {
    if (!selected) return;
    const target = selected;
    const deleted = await runAction(
      "delete",
      async () => {
        await api.deleteRoleCv(target.id);
        return true;
      },
      "Could not delete the Role CV.",
    );
    if (deleted) {
      queryClient.setQueryData<RoleCv[]>(queryKeys.roleCvs.list(), (current) =>
        (current ?? []).filter((item) => item.id !== target.id),
      );
      setSelectedId(null);
      toast.success("Role CV deleted");
    }
  };

  const newButton = (
    <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
      <Plus className="h-4 w-4" />
      New Role CV
    </Button>
  );

  return (
    <>
      <PageHeader
        icon={FileStack}
        title="Role CVs"
        subtitle="CV versions for the roles you target"
        actions={newButton}
      />

      <PageMain>
        {roleCvsQuery.isLoading ? (
          <SectionCard>
            <p className="py-10 text-center text-sm text-muted-foreground">
              Loading Role CVs...
            </p>
          </SectionCard>
        ) : roleCvsQuery.error ? (
          <SectionCard>
            <EmptyState
              icon={FileStack}
              title="Could not load Role CVs"
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void roleCvsQuery.refetch()}
                >
                  Try again
                </Button>
              }
            />
          </SectionCard>
        ) : roleCvs.length === 0 || !selected ? (
          <SectionCard>
            <EmptyState
              icon={FileStack}
              title="No Role CVs yet"
              description="Make one CV per target role, built from your resume."
              action={newButton}
            />
          </SectionCard>
        ) : (
          <section className="grid gap-4 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
            <ListPanel className="lg:self-start">
              {roleCvs.map((roleCv) => (
                <ListItem
                  key={roleCv.id}
                  selected={roleCv.id === selected.id}
                  onClick={() => setSelectedId(roleCv.id)}
                >
                  <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {roleCv.name}
                    </span>
                    <RoleCvStatusBadge roleCv={roleCv} />
                  </div>
                </ListItem>
              ))}
            </ListPanel>
            <SectionCard>
              <RoleCvEditor
                key={`${selected.id}:${selected.updatedAt}`}
                roleCv={selected}
                catalog={catalogQuery.data ?? []}
                resumeProjects={settings?.resumeProjects?.value ?? null}
                busyAction={busyAction}
                onSave={handleSave}
                onGenerate={handleGenerate}
                onGeneratePdf={handleGeneratePdf}
                onOpenPdf={handleOpenPdf}
                onDownloadPdf={handleDownloadPdf}
                onDelete={() => setDeleteOpen(true)}
              />
            </SectionCard>
          </section>
        )}
      </PageMain>

      <CreateRoleCvDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(roleCv) => {
          replaceInCache(roleCv);
          setSelectedId(roleCv.id);
          setCreateOpen(false);
        }}
      />

      <ConfirmDelete
        isOpen={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => void handleDelete()}
        title="Delete this Role CV?"
        description="This removes the Role CV and its PDF."
      />
    </>
  );
};
