import { Notice } from '@/components/Notice';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { inputClass, selectClass } from '@/components/ui/form';
import { type PipelineView } from '@/domain/schemas';
import { request } from '@/lib/http';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

export const CreateLeadDialog = ({
  defaultPipelineId,
  onOpenChange,
  pipelines,
}: {
  readonly defaultPipelineId?: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly pipelines: PipelineView[];
}) => {
  const queryClient = useQueryClient();
  const [pipelineId, setPipelineId] = useState(
    defaultPipelineId ??
      pipelines.find((item) => item.stages.length > 0)?.id ??
      pipelines[0]?.id ??
      '',
  );
  const pipeline = pipelines.find((item) => item.id === pipelineId);
  const [values, setValues] = useState({
    email: '',
    estimatedValue: '',
    firstName: '',
    lastName: '',
    name: '',
    source: 'Website',
    stageId: pipeline?.stages[0]?.id ?? '',
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
          pipelineId: pipelineId || undefined,
          source: values.source.trim() || undefined,
          stageId: values.stageId || undefined,
        }),
        method: 'POST',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      void queryClient.invalidateQueries({ queryKey: ['lead-stage-counts'] });
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
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Pipeline">
          <select
            className={selectClass}
            disabled={pipelines.length === 0}
            onChange={(event) => {
              const next = pipelines.find(
                (item) => item.id === event.target.value,
              );
              setPipelineId(event.target.value);
              setValues({
                ...values,
                stageId: next?.stages[0]?.id ?? '',
              });
            }}
            value={pipelineId}
          >
            {pipelines.length === 0 && <option value="">No pipelines</option>}
            {pipelines.map((item) => (
              <option
                key={item.id}
                value={item.id}
              >
                {item.name}
              </option>
            ))}
          </select>
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
        <Field
          hint="Shown as the lead name. Defaults to the person's name or email."
          label="Title"
        >
          <input
            className={inputClass}
            onChange={(event) =>
              setValues({ ...values, name: event.target.value })
            }
            placeholder="New service inquiry"
            value={values.name}
          />
        </Field>
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
            disabled={!pipeline || pipeline.stages.length === 0}
            onChange={(event) =>
              setValues({ ...values, stageId: event.target.value })
            }
            value={values.stageId}
          >
            {(!pipeline || pipeline.stages.length === 0) && (
              <option value="">No stages</option>
            )}
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
            disabled={create.isPending || values.stageId === ''}
            type="submit"
          >
            Create lead
          </Button>
        </div>
      </form>
    </Dialog>
  );
};
