import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { inputClass } from '@/components/ui/form';
import { useState } from 'react';

export const PipelineNameDialog = ({
  initialName = '',
  onOpenChange,
  onSubmit,
  open,
  pending,
  title,
}: {
  readonly initialName?: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (name: string) => void;
  readonly open: boolean;
  readonly pending: boolean;
  readonly title: string;
}) => {
  const [name, setName] = useState(initialName);

  const trimmed = name.trim();
  return (
    <Dialog
      onOpenChange={onOpenChange}
      open={open}
      title={title}
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed !== '') {
            onSubmit(trimmed);
          }
        }}
      >
        <Field label="Pipeline name">
          <input
            autoFocus
            className={inputClass}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => onOpenChange(false)}
            tone="secondary"
          >
            Cancel
          </Button>
          <Button
            disabled={pending || trimmed === ''}
            type="submit"
          >
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};
