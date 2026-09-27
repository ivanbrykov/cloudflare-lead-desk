import { PipelineNameDialog } from './PipelineNameDialog';
import { STAGE_COLORS } from './stageColors';
import { StageRow } from './StageRow';
import { Button } from '@/components/ui/Button';
import { inputClass, selectClass } from '@/components/ui/form';
import { type PipelineView } from '@/domain/schemas';
import { request } from '@/lib/http';
import { cn } from '@/lib/styles';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

const notifyError = (error: unknown) => {
  toast.error(error instanceof Error ? error.message : 'Something went wrong.');
};

export const PipelineSection = ({
  onChanged,
  pipeline,
}: {
  readonly onChanged: () => void;
  readonly pipeline: PipelineView;
}) => {
  const [showRename, setShowRename] = useState(false);
  const [newStageName, setNewStageName] = useState('');
  const [newStageColor, setNewStageColor] = useState<string>('slate');

  const rename = useMutation({
    mutationFn: (name: string) =>
      request(`/v1/pipelines/${pipeline.id}`, {
        body: JSON.stringify({ name }),
        method: 'PATCH',
      }),
    onError: notifyError,
    onSuccess: () => {
      setShowRename(false);
      toast.success('Pipeline renamed');
      onChanged();
    },
  });
  const setArchived = useMutation({
    mutationFn: (archived: boolean) =>
      request(`/v1/pipelines/${pipeline.id}`, {
        body: JSON.stringify({ archived }),
        method: 'PATCH',
      }),
    onError: notifyError,
    onSuccess: (_data, archived) => {
      toast.success(archived ? 'Pipeline archived' : 'Pipeline unarchived');
      onChanged();
    },
  });
  const addStage = useMutation({
    mutationFn: () =>
      request(`/v1/pipelines/${pipeline.id}/stages`, {
        body: JSON.stringify({
          color: newStageColor,
          name: newStageName.trim(),
        }),
        method: 'POST',
      }),
    onError: notifyError,
    onSuccess: () => {
      setNewStageName('');
      setNewStageColor('slate');
      toast.success('Stage added');
      onChanged();
    },
  });
  const updateStage = useMutation({
    mutationFn: ({
      input,
      stageId,
    }: {
      input: { color?: string; name?: string };
      stageId: string;
    }) =>
      request(`/v1/pipelines/${pipeline.id}/stages/${stageId}`, {
        body: JSON.stringify(input),
        method: 'PATCH',
      }),
    onError: notifyError,
    onSuccess: () => {
      toast.success('Stage updated');
      onChanged();
    },
  });
  const deleteStage = useMutation({
    mutationFn: (stageId: string) =>
      request(`/v1/pipelines/${pipeline.id}/stages/${stageId}`, {
        method: 'DELETE',
      }),
    onError: notifyError,
    onSuccess: () => {
      toast.success('Stage deleted');
      onChanged();
    },
  });
  const reorder = useMutation({
    mutationFn: (stageIds: string[]) =>
      request(`/v1/pipelines/${pipeline.id}/stages/reorder`, {
        body: JSON.stringify({ stageIds }),
        method: 'POST',
      }),
    onError: notifyError,
    onSuccess: () => {
      toast.success('Stages reordered');
      onChanged();
    },
  });

  const pending =
    rename.isPending ||
    setArchived.isPending ||
    addStage.isPending ||
    updateStage.isPending ||
    deleteStage.isPending ||
    reorder.isPending;
  const move = (index: number, direction: -1 | 1) => {
    const next = pipeline.stages.map((stage) => stage.id);
    const target = index + direction;
    const currentId = next[index];
    const targetId = next[target];
    if (currentId === undefined || targetId === undefined) {
      return;
    }

    next[index] = targetId;
    next[target] = currentId;
    reorder.mutate(next);
  };

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold text-white">{pipeline.name}</h2>
          {pipeline.archivedAt !== null && (
            <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
              Archived
            </span>
          )}
          <span className="text-xs text-slate-500">
            {pipeline.stages.length}{' '}
            {pipeline.stages.length === 1 ? 'stage' : 'stages'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            disabled={pending}
            onClick={() => setShowRename(true)}
            tone="secondary"
          >
            Rename
          </Button>
          <Button
            disabled={pending}
            onClick={() => setArchived.mutate(pipeline.archivedAt === null)}
            tone="secondary"
          >
            {pipeline.archivedAt === null ? 'Archive' : 'Unarchive'}
          </Button>
        </div>
      </header>
      <div className="px-4 py-1">
        {pipeline.stages.map((stage, index) => (
          <StageRow
            index={index}
            key={stage.id}
            onDelete={() => deleteStage.mutate(stage.id)}
            onMove={(direction) => move(index, direction)}
            onSave={(input) => updateStage.mutate({ input, stageId: stage.id })}
            pending={pending}
            stage={stage}
            total={pipeline.stages.length}
          />
        ))}
        {pipeline.stages.length === 0 && (
          <p className="border-t border-slate-800 py-3 text-sm text-slate-400">
            No stages yet.
          </p>
        )}
        <form
          className="flex flex-wrap items-center gap-2 border-t border-slate-800 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (newStageName.trim() !== '') {
              addStage.mutate();
            }
          }}
        >
          <input
            aria-label="New stage name"
            className={cn(inputClass, 'h-8 min-w-40 flex-1')}
            onChange={(event) => setNewStageName(event.target.value)}
            placeholder="New stage name"
            value={newStageName}
          />
          <select
            aria-label="New stage color"
            className={cn(selectClass, 'h-8 w-28')}
            onChange={(event) => setNewStageColor(event.target.value)}
            value={newStageColor}
          >
            {STAGE_COLORS.map((option) => (
              <option
                key={option}
                value={option}
              >
                {option}
              </option>
            ))}
          </select>
          <Button
            disabled={pending || newStageName.trim() === ''}
            tone="secondary"
            type="submit"
          >
            Add stage
          </Button>
        </form>
      </div>
      {showRename && (
        <PipelineNameDialog
          initialName={pipeline.name}
          onOpenChange={setShowRename}
          onSubmit={(name) => rename.mutate(name)}
          open
          pending={rename.isPending}
          title="Rename pipeline"
        />
      )}
    </section>
  );
};
