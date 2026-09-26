import { cn } from '@/lib/styles';

export const StageChip = ({
  active,
  count,
  label,
  onClick,
}: {
  readonly active: boolean;
  readonly count: number;
  readonly label: string;
  readonly onClick: () => void;
}) => (
  <button
    className={cn(
      'rounded-full border px-3 py-1 text-xs font-medium transition',
      active
        ? 'border-cyan-400 bg-cyan-400/10 text-cyan-200'
        : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200',
    )}
    onClick={onClick}
    type="button"
  >
    {label} <span className="text-slate-500">{count}</span>
  </button>
);
