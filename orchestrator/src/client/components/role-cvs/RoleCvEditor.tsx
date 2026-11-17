import { TokenizedInput } from "@client/pages/orchestrator/TokenizedInput";
import { resolveResumeProjectSelection } from "@shared/resume-projects";
import type {
  ResumeProjectCatalogItem,
  ResumeProjectsSettings,
  RoleCv,
  UpdateRoleCvInput,
} from "@shared/types";
import {
  AlertTriangle,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Plus,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ProjectSelector } from "../discovered-panel/ProjectSelector";
import {
  createTailoredSkillDraftId,
  type EditableSkillGroup,
  fromEditableSkillGroups,
  parseTailoredSkills,
  serializeTailoredSkills,
  toEditableSkillGroups,
} from "../tailoring-utils";

export type RoleCvBusyAction = "save" | "generate" | "pdf" | "delete" | null;

interface RoleCvEditorProps {
  roleCv: RoleCv;
  catalog: ResumeProjectCatalogItem[];
  resumeProjects: ResumeProjectsSettings | null;
  busyAction: RoleCvBusyAction;
  onSave: (input: UpdateRoleCvInput) => Promise<void>;
  onGenerate: (pendingChanges: UpdateRoleCvInput | null) => Promise<void>;
  onGeneratePdf: (pendingChanges: UpdateRoleCvInput | null) => Promise<void>;
  onOpenPdf: () => void;
  onDownloadPdf: () => void;
  onDelete: () => void;
}

const parseKeywords = (input: string): string[] =>
  input
    .split(/[\n,]/g)
    .map((keyword) => keyword.trim())
    .filter(Boolean);

const parseIds = (csv: string | null): string[] =>
  (csv ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

const normalizeSkills = (raw: string | null) =>
  serializeTailoredSkills(parseTailoredSkills(raw));

export const RoleCvStatusBadge: React.FC<{ roleCv: RoleCv }> = ({ roleCv }) => {
  if (!roleCv.generatedAt) {
    return <Badge variant="secondary">Not generated</Badge>;
  }
  if (roleCv.isStale) {
    return (
      <Badge
        variant="outline"
        className="border-amber-500/40 text-amber-600 dark:text-amber-300"
      >
        Outdated
      </Badge>
    );
  }
  return <Badge variant="outline">Up to date</Badge>;
};

export const RoleCvEditor: React.FC<RoleCvEditorProps> = ({
  roleCv,
  catalog,
  resumeProjects,
  busyAction,
  onSave,
  onGenerate,
  onGeneratePdf,
  onOpenPdf,
  onDownloadPdf,
  onDelete,
}) => {
  const [name, setName] = useState(roleCv.name);
  const [roleDescription, setRoleDescription] = useState(
    roleCv.roleDescription,
  );
  const [headline, setHeadline] = useState(roleCv.tailoredHeadline ?? "");
  const [summary, setSummary] = useState(roleCv.tailoredSummary ?? "");
  const [skills, setSkills] = useState<EditableSkillGroup[]>(() =>
    toEditableSkillGroups(parseTailoredSkills(roleCv.tailoredSkills)),
  );
  const [keywordDrafts, setKeywordDrafts] = useState<Record<string, string>>(
    {},
  );
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    parseIds(roleCv.selectedProjectIds),
  );

  const skillsJson = serializeTailoredSkills(fromEditableSkillGroups(skills));
  const selectedIdsCsv = selectedIds.join(",");

  const changes = useMemo<UpdateRoleCvInput | null>(() => {
    const next: UpdateRoleCvInput = {};
    if (name.trim() !== roleCv.name) next.name = name.trim();
    if (roleDescription.trim() !== roleCv.roleDescription) {
      next.roleDescription = roleDescription;
    }
    if (headline !== (roleCv.tailoredHeadline ?? "")) {
      next.tailoredHeadline = headline;
    }
    if (summary !== (roleCv.tailoredSummary ?? "")) {
      next.tailoredSummary = summary;
    }
    if (skillsJson !== normalizeSkills(roleCv.tailoredSkills)) {
      next.tailoredSkills = skillsJson;
    }
    if (selectedIdsCsv !== parseIds(roleCv.selectedProjectIds).join(",")) {
      next.selectedProjectIds = selectedIdsCsv;
    }
    return Object.keys(next).length > 0 ? next : null;
  }, [
    name,
    roleDescription,
    headline,
    summary,
    skillsJson,
    selectedIdsCsv,
    roleCv,
  ]);

  const projectResolution = useMemo(
    () =>
      resumeProjects
        ? resolveResumeProjectSelection({
            catalog,
            resumeProjects,
            selectedProjectIds: selectedIds,
          })
        : null,
    [catalog, resumeProjects, selectedIds],
  );

  const isBusy = busyAction !== null;
  const nameMissing = name.trim().length === 0;
  const hasContent = Boolean(roleCv.generatedAt || headline || summary);
  const hasPdf = roleCv.pdfFreshness !== "missing";

  const handleToggleProject = (id: string) => {
    if (!projectResolution) return;
    if (!projectResolution.aiSelectableIds.includes(id)) return;
    const mustInclude = new Set(projectResolution.mustIncludeIds);
    const next = projectResolution.effectiveSelectedIds.filter(
      (projectId) => !mustInclude.has(projectId),
    );
    const index = next.indexOf(id);
    if (index >= 0) next.splice(index, 1);
    else if (
      projectResolution.effectiveSelectedIds.length <
      projectResolution.targetCount
    ) {
      next.push(id);
    }
    setSelectedIds(next);
  };

  const updateSkill = (
    id: string,
    key: "name" | "keywordsText",
    value: string,
  ) => {
    setSkills((current) =>
      current.map((group) =>
        group.id === id ? { ...group, [key]: value } : group,
      ),
    );
  };

  const pdfLabel =
    roleCv.pdfFreshness === "missing"
      ? "Make PDF"
      : roleCv.pdfFreshness === "stale"
        ? "Update PDF"
        : "Remake PDF";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-base font-semibold">{roleCv.name}</h2>
          <RoleCvStatusBadge roleCv={roleCv} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void onGenerate(changes)}
            disabled={isBusy || nameMissing || !roleDescription.trim()}
          >
            {busyAction === "generate" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {roleCv.generatedAt ? "Regenerate" : "Generate"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => changes && void onSave(changes)}
            disabled={isBusy || !changes || nameMissing}
          >
            {busyAction === "save" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save
          </Button>
        </div>
      </div>

      {roleCv.isStale ? (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Your resume changed since this CV was generated. Regenerate to catch
            up.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="role-cv-name">Name</Label>
          <Input
            id="role-cv-name"
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            disabled={isBusy}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="role-cv-headline">Headline</Label>
          <Input
            id="role-cv-headline"
            value={headline}
            maxLength={500}
            onChange={(event) => setHeadline(event.target.value)}
            placeholder="Backend Engineer"
            disabled={isBusy}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="role-cv-description">Role description</Label>
        <Textarea
          id="role-cv-description"
          value={roleDescription}
          onChange={(event) => setRoleDescription(event.target.value)}
          placeholder="What this role does and what it needs."
          className="min-h-[96px]"
          disabled={isBusy}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="role-cv-summary">Summary</Label>
        <Textarea
          id="role-cv-summary"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          className="min-h-[120px]"
          disabled={isBusy}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Skills</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() =>
              setSkills((current) => [
                ...current,
                {
                  id: createTailoredSkillDraftId(),
                  name: "",
                  keywordsText: "",
                },
              ])
            }
            disabled={isBusy}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add group
          </Button>
        </div>
        {skills.length === 0 ? (
          <p className="rounded-md border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
            No skills yet.
          </p>
        ) : (
          <div className="space-y-2">
            {skills.map((group, index) => (
              <div
                key={group.id}
                className="space-y-2 rounded-md border border-border/55 bg-background/45 p-3"
              >
                <div className="flex items-end gap-2">
                  <div className="flex-1 space-y-1">
                    <Label
                      htmlFor={`role-cv-skill-name-${group.id}`}
                      className="text-xs text-muted-foreground"
                    >
                      Category
                    </Label>
                    <Input
                      id={`role-cv-skill-name-${group.id}`}
                      value={group.name}
                      onChange={(event) =>
                        updateSkill(group.id, "name", event.target.value)
                      }
                      placeholder={`Group ${index + 1}`}
                      disabled={isBusy}
                    />
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-9 w-9 text-muted-foreground"
                    aria-label={`Remove ${group.name || `group ${index + 1}`}`}
                    onClick={() =>
                      setSkills((current) =>
                        current.filter((item) => item.id !== group.id),
                      )
                    }
                    disabled={isBusy}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <TokenizedInput
                  id={`role-cv-skill-keywords-${group.id}`}
                  values={parseKeywords(group.keywordsText)}
                  draft={keywordDrafts[group.id] ?? ""}
                  parseInput={parseKeywords}
                  onDraftChange={(value) =>
                    setKeywordDrafts((current) => ({
                      ...current,
                      [group.id]: value,
                    }))
                  }
                  onValuesChange={(values) =>
                    updateSkill(group.id, "keywordsText", values.join(", "))
                  }
                  placeholder="Add a keyword"
                  removeLabelPrefix="Remove keyword"
                  disabled={isBusy}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {catalog.length > 0 && projectResolution ? (
        <div className="space-y-2">
          <span className="text-sm font-medium">Projects</span>
          <ProjectSelector
            catalog={catalog}
            resolution={projectResolution}
            onToggle={handleToggleProject}
            disabled={isBusy}
          />
        </div>
      ) : null}

      <div className="space-y-3 rounded-lg border border-border/60 bg-background/40 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">PDF</span>
            <span className="text-xs text-muted-foreground">
              {roleCv.pdfFreshness === "missing"
                ? "Not made yet"
                : roleCv.pdfFreshness === "stale"
                  ? "Out of date"
                  : roleCv.pdfFreshness === "regenerating"
                    ? "Making..."
                    : "Up to date"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void onGeneratePdf(changes)}
              disabled={
                isBusy ||
                nameMissing ||
                !hasContent ||
                roleCv.pdfFreshness === "regenerating"
              }
            >
              {busyAction === "pdf" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileText className="h-4 w-4" />
              )}
              {pdfLabel}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onOpenPdf}
              disabled={!hasPdf || busyAction === "pdf"}
            >
              <ExternalLink className="h-4 w-4" />
              Open
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onDownloadPdf}
              disabled={!hasPdf || busyAction === "pdf"}
            >
              <Download className="h-4 w-4" />
              Download
            </Button>
          </div>
        </div>
      </div>

      <div className="flex justify-end border-t border-border/60 pt-4">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
          disabled={isBusy}
        >
          <Trash2 className="h-4 w-4" />
          Delete
        </Button>
      </div>
    </div>
  );
};
