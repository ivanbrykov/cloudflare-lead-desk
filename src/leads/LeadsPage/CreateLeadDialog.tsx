import { Notice } from '@/components/Notice';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { inputClass } from '@/components/ui/form';
import {
  emptyLeadFormValues,
  type LeadFormValues,
  toCreateLeadInput,
} from '@/leads/leadFormValues';
import { request } from '@/lib/http';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

export const CreateLeadDialog = ({
  onOpenChange,
}: {
  readonly onOpenChange: (open: boolean) => void;
}) => {
  const queryClient = useQueryClient();
  const form = useForm<LeadFormValues>({
    defaultValues: emptyLeadFormValues,
    mode: 'onTouched',
  });
  const create = useMutation({
    mutationFn: (values: LeadFormValues) =>
      request('/v1/leads', {
        body: JSON.stringify(toCreateLeadInput(values)),
        method: 'POST',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      toast.success('Lead created');
      onOpenChange(false);
    },
  });

  return (
    <Dialog
      onOpenChange={onOpenChange}
      open
      title="New lead"
    >
      <form
        className="grid gap-3"
        onSubmit={form.handleSubmit((values) => {
          create.mutate(values);
        })}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name">
            <input
              className={inputClass}
              {...form.register('firstName')}
            />
          </Field>
          <Field label="Last name">
            <input
              className={inputClass}
              {...form.register('lastName')}
            />
          </Field>
        </div>
        <Field label="Email">
          <input
            className={inputClass}
            type="email"
            {...form.register('email')}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Source">
            <input
              className={inputClass}
              {...form.register('source')}
            />
          </Field>
          <Field label="Estimated value">
            <input
              className={inputClass}
              min="0"
              type="number"
              {...form.register('estimatedValue')}
            />
          </Field>
        </div>
        {create.error && <Notice error={create.error} />}
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => onOpenChange(false)}
            tone="secondary"
          >
            Cancel
          </Button>
          <Button
            disabled={create.isPending}
            type="submit"
          >
            Create lead
          </Button>
        </div>
      </form>
    </Dialog>
  );
};
