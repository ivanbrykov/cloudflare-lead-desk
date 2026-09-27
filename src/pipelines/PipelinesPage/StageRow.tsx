import { STAGE_COLORS, stageColorClass } from './stageColors';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/Button';
import { inputClass, selectClass } from '@/components/ui/form';
import { type StageView } from '@/domain/schemas';
import { cn } from '@/lib/styles';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { useState } from 'react';

export const StageRow = ({
  index,
  onDelete,
  onMove,
  onSave,
  pending,
  stage,
  total,
}: {
  readonly index: number;
  readonly onDelete: () => void;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onSave: (input: { color?: string; name?: string }) => void;
  readonly pending: boolean;
  readonly stage: StageView;
  readonly total: number;
}) => {
  const [name, setName] = useState(stage.name);
  const [color, setColor] = useState(stage.color);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const trimmed = name.trim();
  const dirty = trimmed !== stage.name || color !== stage.color;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 py-2">
      <span
        aria-hidden
        className={cn('size-3 shrink-0 rounded-full', stageColorClass(color))}
      />
      <input
        aria-label={`Stage ${index + 1} name`}
        className={cn(inputClass, 'h-8 min-w-40 flex-1')}
        onChange={(event) => setName(event.target.value)}
        value={name}
      />
      <select
        aria-label={`Stage ${index + 1} color`}
        className={cn(selectClass, 'h-8 w-28')}
        onChange={(event) => setColor(event.target.value)}
        value={color}
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
      {dirty && (
        <Button
          disabled={pending || trimmed === ''}
          onClick={() => {
            onSave({ color, name: trimmed });
            setName(trimmed);
          }}
          tone="secondary"
        >
          Save
        </Button>
      )}
      <Button
        aria-label="Move stage up"
        disabled={pending || index === 0}
        onClick={() => onMove(-1)}
        tone="secondary"
      >
        <ArrowUp size={14} />
      </Button>
      <Button
        aria-label="Move stage down"
        disabled={pending || index === total - 1}
        onClick={() => onMove(1)}
        tone="secondary"
      >
        <ArrowDown size={14} />
      </Button>
      <Button
        aria-label="Delete stage"
        disabled={pending}
        onClick={() => setConfirmDelete(true)}
        tone="danger"
      >
        <Trash2 size={14} />
      </Button>
      <ConfirmDialog
        description={`Delete stage "${stage.name}"? Leads must be moved out of it first.`}
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete();
        }}
        onOpenChange={setConfirmDelete}
        open={confirmDelete}
        pending={pending}
        title="Delete stage"
      />
    </div>
  );
};
