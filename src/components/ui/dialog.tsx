import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/styles';

export const Dialog = ({
  children,
  open,
  onOpenChange,
  title,
}: {
  children: ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
}) => (
  <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 bg-slate-950/60" />
      <BaseDialog.Popup className="fixed left-1/2 top-1/2 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between gap-4">
          <BaseDialog.Title className="text-base font-semibold text-white">{title}</BaseDialog.Title>
          <BaseDialog.Close className={cn('rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white')}>
            <X size={18} />
          </BaseDialog.Close>
        </div>
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  </BaseDialog.Root>
);
