import { Notice } from '@/components/Notice';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { inputClass, selectClass } from '@/components/ui/form';
import {
  type LeadActivity,
  type LeadView,
  type PipelineView,
} from '@/domain/schemas';
import { request } from '@/lib/http';
import { cn } from '@/lib/styles';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'wouter';

const formatCustomValue = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

const nullable = (value: string): null | string =>
  value.trim() === '' ? null : value.trim();

export const LeadDetailPage = ({ id }: { readonly id: string }) => {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const lead = useQuery({
    queryFn: () => request<LeadView>(`/v1/leads/${id}`),
    queryKey: ['lead', id],
  });
  const activities = useQuery({
    queryFn: () => request<LeadActivity[]>(`/v1/leads/${id}/activities`),
    queryKey: ['lead-activities', id],
  });
  const pipelines = useQuery({
    queryFn: () => request<PipelineView[]>('/v1/pipelines'),
    queryKey: ['pipelines'],
  });
  const pipeline = (pipelines.data ?? []).find(
    (item) => item.id === lead.data?.pipelineId,
  );
  const [note, setNote] = useState('');
  const [draft, setDraft] = useState<null | {
    email: string;
    estimatedValue: string;
    firstName: string;
    lastName: string;
    name: string;
    source: string;
  }>(null);

  const record = lead.data;
  const currentDraft =
    draft ??
    (record
      ? {
          email: record.email ?? '',
          estimatedValue:
            record.estimatedValue === null ? '' : String(record.estimatedValue),
          firstName: record.firstName ?? '',
          lastName: record.lastName ?? '',
          name: record.name,
          source: record.source,
        }
      : null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['lead', id] });
    void queryClient.invalidateQueries({ queryKey: ['leads'] });
  };

  const save = useMutation({
    mutationFn: () =>
      request(`/v1/leads/${id}`, {
        body: JSON.stringify({
          email: currentDraft ? nullable(currentDraft.email) : undefined,
          estimatedValue:
            currentDraft && currentDraft.estimatedValue.trim() === ''
              ? null
              : Number(currentDraft?.estimatedValue),
          firstName: currentDraft
            ? nullable(currentDraft.firstName)
            : undefined,
          lastName: currentDraft ? nullable(currentDraft.lastName) : undefined,
          name: currentDraft?.name.trim() || undefined,
          source: currentDraft?.source.trim() || undefined,
        }),
        method: 'PATCH',
      }),
    onSuccess: () => {
      setDraft(null);
      invalidate();
    },
  });
  const setStage = useMutation({
    mutationFn: (stageId: string) =>
      request(`/v1/leads/${id}`, {
        body: JSON.stringify({ stageId }),
        method: 'PATCH',
      }),
    onSuccess: invalidate,
  });
  const addNote = useMutation({
    mutationFn: () =>
      request(`/v1/leads/${id}/activities`, {
        body: JSON.stringify({ body: note }),
        method: 'POST',
      }),
    onSuccess: () => {
      setNote('');
      void queryClient.invalidateQueries({
        queryKey: ['lead-activities', id],
      });
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      request('/v1/leads/bulk-delete', {
        body: JSON.stringify({ ids: [id] }),
        method: 'POST',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      setLocation('/leads');
    },
  });

  if (lead.isPending) {
    return <p className="p-8 text-slate-400">Loading lead…</p>;
  }

  if (lead.error || !record || !currentDraft) {
    return (
      <div className="p-8">
        <Notice error={lead.error ?? new Error('Lead not found.')} />
      </div>
    );
  }

  return (
    <>
      <PageHeader
        action={
          <div className="flex items-center gap-2">
            <Link
              className="inline-flex h-9 items-center gap-1 rounded-md px-3 text-sm font-semibold text-slate-300 hover:text-white"
              href="/leads"
            >
              <ChevronLeft size={16} /> Leads
            </Link>
            <Button
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
              tone="danger"
            >
              Delete
            </Button>
          </div>
        }
        eyebrow="Lead"
        title={record.name}
      />
      <div className="grid gap-5 p-5 sm:p-8 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-800 p-5">
          <h2 className="mb-4 font-semibold text-white">Details</h2>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="First name">
                <input
                  className={inputClass}
                  onChange={(event) =>
                    setDraft({ ...currentDraft, firstName: event.target.value })
                  }
                  value={currentDraft.firstName}
                />
              </Field>
              <Field label="Last name">
                <input
                  className={inputClass}
                  onChange={(event) =>
                    setDraft({ ...currentDraft, lastName: event.target.value })
                  }
                  value={currentDraft.lastName}
                />
              </Field>
            </div>
            <Field label="Email">
              <input
                className={inputClass}
                onChange={(event) =>
                  setDraft({ ...currentDraft, email: event.target.value })
                }
                type="email"
                value={currentDraft.email}
              />
            </Field>
            <Field
              hint="Shown as the lead name. Defaults to the person's name or email."
              label="Title"
            >
              <input
                className={inputClass}
                onChange={(event) =>
                  setDraft({ ...currentDraft, name: event.target.value })
                }
                value={currentDraft.name}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Source">
                <input
                  className={inputClass}
                  onChange={(event) =>
                    setDraft({ ...currentDraft, source: event.target.value })
                  }
                  value={currentDraft.source}
                />
              </Field>
              <Field label="Estimated value">
                <input
                  className={inputClass}
                  min="0"
                  onChange={(event) =>
                    setDraft({
                      ...currentDraft,
                      estimatedValue: event.target.value,
                    })
                  }
                  type="number"
                  value={currentDraft.estimatedValue}
                />
              </Field>
            </div>
            <Field label="Stage">
              <select
                className={selectClass}
                onChange={(event) => setStage.mutate(event.target.value)}
                value={record.stageId}
              >
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
            {save.error && <Notice error={save.error} />}
            <div>
              <Button
                disabled={save.isPending}
                type="submit"
              >
                Save
              </Button>
            </div>
          </form>
          <dl className="mt-5 grid gap-2 text-sm">
            {Object.entries(record.customFields).map(([key, value]) => (
              <div
                className="flex justify-between gap-4"
                key={key}
              >
                <dt className="text-slate-500">{key}</dt>
                <dd className="text-right text-slate-200">
                  {formatCustomValue(value)}
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="rounded-xl border border-slate-800 p-5">
          <h2 className="mb-4 font-semibold text-white">Activity</h2>
          <form
            className="mb-4 grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (note.trim()) {
                addNote.mutate();
              }
            }}
          >
            <textarea
              className={cn(inputClass, 'min-h-20')}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Add a note…"
              rows={3}
              value={note}
            />
            {addNote.error && <Notice error={addNote.error} />}
            <div>
              <Button
                disabled={!note.trim() || addNote.isPending}
                type="submit"
              >
                Add note
              </Button>
            </div>
          </form>
          <ul className="grid gap-3">
            {(activities.data ?? []).map((activity) => (
              <li
                className="rounded-lg border border-slate-800 bg-slate-900/40 p-3"
                key={activity.id}
              >
                <p className="whitespace-pre-wrap text-sm text-slate-200">
                  {activity.body}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {activity.actorEmail ?? 'System'} ·{' '}
                  {new Date(activity.createdAt).toLocaleString()}
                </p>
              </li>
            ))}
            {activities.data?.length === 0 && (
              <li className="text-sm text-slate-400">No activity yet.</li>
            )}
          </ul>
        </section>
      </div>
    </>
  );
};
