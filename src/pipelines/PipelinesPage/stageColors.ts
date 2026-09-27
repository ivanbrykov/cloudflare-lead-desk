export const STAGE_COLORS = [
  'slate',
  'blue',
  'cyan',
  'emerald',
  'amber',
  'rose',
  'violet',
] as const;

const swatches: Record<string, string> = {
  amber: 'bg-amber-400',
  blue: 'bg-blue-400',
  cyan: 'bg-cyan-400',
  emerald: 'bg-emerald-400',
  rose: 'bg-rose-400',
  slate: 'bg-slate-400',
  violet: 'bg-violet-400',
};

export const stageColorClass = (color: string): string =>
  swatches[color] ?? 'bg-slate-500';
