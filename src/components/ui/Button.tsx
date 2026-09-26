import { cn } from '@/lib/styles';
import { type ButtonHTMLAttributes } from 'react';

type ButtonProperties = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly tone?: 'danger' | 'primary' | 'secondary';
};

export const Button = ({
  className,
  tone = 'primary',
  ...properties
}: ButtonProperties) => (
  <button
    className={cn(
      'inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
      tone === 'primary' &&
        'bg-cyan-400 text-slate-950 hover:bg-cyan-300 focus-visible:outline-cyan-400',
      tone === 'secondary' &&
        'bg-slate-800 text-slate-100 hover:bg-slate-700 focus-visible:outline-slate-300',
      tone === 'danger' &&
        'bg-rose-500 text-white hover:bg-rose-400 focus-visible:outline-rose-500',
      className,
    )}
    type="button"
    {...properties}
  />
);
