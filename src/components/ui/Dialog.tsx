import { cn } from '@/lib/styles';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { type ReactNode } from 'react';

export const Dialog = ({
  children,
  onOpenChange,
  open,
  title,
}: {
  readonly children: ReactNode;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly title: string;
}) => (
  <BaseDialog.Root
    onOpenChange={onOpenChange}
    open={open}
  >
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 bg-slate-950/60" />
      <BaseDialog.Popup className="fixed left-1/2 top-1/2 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between gap-4">
          <BaseDialog.Title className="text-base font-semibold text-white">
            {title}
          </BaseDialog.Title>
          <BaseDialog.Close
            className={cn(
              'rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white',
            )}
          >
            <X size={18} />
          </BaseDialog.Close>
        </div>
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  </BaseDialog.Root>
);
