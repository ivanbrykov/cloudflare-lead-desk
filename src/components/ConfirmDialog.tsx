import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

export const ConfirmDialog = ({
  confirmLabel = 'Delete',
  description,
  onConfirm,
  onOpenChange,
  open,
  pending = false,
  title,
}: {
  readonly confirmLabel?: string;
  readonly description: string;
  readonly onConfirm: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly pending?: boolean;
  readonly title: string;
}) => (
  <Dialog
    onOpenChange={onOpenChange}
    open={open}
    title={title}
  >
    <div className="grid gap-4">
      <p className="text-sm text-slate-300">{description}</p>
      <div className="flex justify-end gap-2">
        <Button
          onClick={() => onOpenChange(false)}
          tone="secondary"
        >
          Cancel
        </Button>
        <Button
          disabled={pending}
          onClick={onConfirm}
          tone="danger"
        >
          {pending ? 'Deleting…' : confirmLabel}
        </Button>
      </div>
    </div>
  </Dialog>
);
