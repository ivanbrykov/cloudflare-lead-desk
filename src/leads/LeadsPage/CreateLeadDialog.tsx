import { Notice } from '@/components/Notice';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { inputClass, selectClass } from '@/components/ui/form';
import { type PipelineView } from '@/domain/schemas';
import { request } from '@/lib/http';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

export const CreateLeadDialog = ({
  onOpenChange,
  pipeline,
}: {
  readonly onOpenChange: (open: boolean) => void;
  readonly pipeline: PipelineView | undefined;
}) => {
  const queryClient = useQueryClient();
  const [values, setValues] = useState({
    email: '',
    estimatedValue: '',
    firstName: '',
    lastName: '',
    name: '',
    source: 'Website',
    stageId: '',
  });
  const create = useMutation({
    mutationFn: () =>
      request('/v1/leads', {
        body: JSON.stringify({
          email: values.email.trim() || undefined,
          estimatedValue:
            values.estimatedValue.trim() === ''
              ? undefined
              : Number(values.estimatedValue),
          firstName: values.firstName.trim() || undefined,
          lastName: values.lastName.trim() || undefined,
          name: values.name.trim() || undefined,
          source: values.source.trim() || undefined,
          stageId: values.stageId || undefined,
        }),
        method: 'POST',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      void queryClient.invalidateQueries({ queryKey: ['lead-stage-counts'] });
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
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Name">
          <input
            className={inputClass}
            onChange={(event) =>
              setValues({ ...values, name: event.target.value })
            }
            value={values.name}
          />
        </Field>
        <Field label="Email">
          <input
            className={inputClass}
            onChange={(event) =>
              setValues({ ...values, email: event.target.value })
            }
            type="email"
            value={values.email}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name">
            <input
              className={inputClass}
              onChange={(event) =>
                setValues({ ...values, firstName: event.target.value })
              }
              value={values.firstName}
            />
          </Field>
          <Field label="Last name">
            <input
              className={inputClass}
              onChange={(event) =>
                setValues({ ...values, lastName: event.target.value })
              }
              value={values.lastName}
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Source">
            <input
              className={inputClass}
              onChange={(event) =>
                setValues({ ...values, source: event.target.value })
              }
              value={values.source}
            />
          </Field>
          <Field label="Estimated value">
            <input
              className={inputClass}
              min="0"
              onChange={(event) =>
                setValues({ ...values, estimatedValue: event.target.value })
              }
              type="number"
              value={values.estimatedValue}
            />
          </Field>
        </div>
        <Field label="Stage">
          <select
            className={selectClass}
            onChange={(event) =>
              setValues({ ...values, stageId: event.target.value })
            }
            value={values.stageId}
          >
            <option value="">Default stage</option>
            {pipeline?.stages.map((stage) => (
              <option
                key={stage.id}
                value={stage.id}
              >
                {stage.name}
              </option>
            ))}
          </select>
        </Field>
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
