import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Notice } from '@/components/Notice';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { inputClass } from '@/components/ui/form';
import { fieldTitle } from '@/domain/customFields';
import { leadDisplayName } from '@/domain/leadDisplay';
import { type LeadActivity, type LeadView } from '@/domain/schemas';
import {
  type LeadFormValues,
  leadFormValuesFromView,
  toUpdateLeadInput,
} from '@/leads/leadFormValues';
import { request } from '@/lib/http';
import { cn } from '@/lib/styles';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Link, useLocation } from 'wouter';

const formatCustomValue = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

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
  const [note, setNote] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const record = lead.data;
  // `values` keeps the form in sync with every server refetch (the query
  // clears the dirty state); edits are preserved while the record is stable.
  const form = useForm<LeadFormValues>({
    mode: 'onTouched',
    values: record ? leadFormValuesFromView(record) : undefined,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['lead', id] });
    void queryClient.invalidateQueries({ queryKey: ['leads'] });
  };

  const save = useMutation({
    mutationFn: (values: LeadFormValues) =>
      request(`/v1/leads/${id}`, {
        body: JSON.stringify(toUpdateLeadInput(values)),
        method: 'PATCH',
      }),
    onSuccess: () => {
      toast.success('Lead saved');
      invalidate();
    },
  });
  const addNote = useMutation({
    mutationFn: () =>
      request(`/v1/leads/${id}/activities`, {
        body: JSON.stringify({ body: note }),
        method: 'POST',
      }),
    onSuccess: () => {
      setNote('');
      toast.success('Note added');
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
      toast.success('Lead deleted');
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      setLocation('/leads');
    },
  });

  if (lead.isPending) {
    return <p className="p-8 text-slate-400">Loading lead…</p>;
  }

  if (lead.error || !record) {
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
              onClick={() => setConfirmDelete(true)}
              tone="danger"
            >
              Delete
            </Button>
          </div>
        }
        eyebrow="Lead"
        title={leadDisplayName(record) ?? 'N/A'}
      />
      <div className="grid gap-5 p-5 sm:p-8 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-800 p-5">
          <h2 className="mb-4 font-semibold text-white">Details</h2>
          <form
            className="grid gap-3"
            onSubmit={form.handleSubmit((values) => {
              save.mutate(values);
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
          {record.skippedFields && record.skippedFields.length > 0 && (
            <p className="mt-5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
              Received with {record.skippedFields.length} field
              {record.skippedFields.length === 1 ? '' : 's'} skipped by the
              browser SDK:{' '}
              {record.skippedFields
                .map(
                  (field) =>
                    `${field.name} (${field.reason === 'sensitive' ? 'sensitive' : 'not marked'})`,
                )
                .join(', ')}
              . Their values were never sent.
            </p>
          )}
          <dl className="mt-5 grid gap-2 text-sm">
            {record.tokenId !== null && (
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Intake</dt>
                <dd className="text-right text-slate-200">
                  {record.tokenType === 'browser'
                    ? 'Browser form'
                    : record.tokenType === 'api'
                      ? 'API integration'
                      : 'Intake token'}
                  {record.tokenName ? ` — ${record.tokenName}` : ''}
                </dd>
              </div>
            )}
            {record.origin !== null && (
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Origin</dt>
                <dd className="text-right text-slate-200">{record.origin}</dd>
              </div>
            )}
            {Object.entries(record.customFields).map(([key, value]) => (
              <div
                className="flex justify-between gap-4"
                key={key}
              >
                <dt className="text-slate-500">{fieldTitle(key)}</dt>
                <dd className="text-right text-slate-200">
                  {formatCustomValue(value)}
                </dd>
              </div>
            ))}
          </dl>
          {record.rawPayload ? (
            <details className="mt-4 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
              <summary className="cursor-pointer text-sm text-slate-400">
                Received payload
              </summary>
              <pre className="mt-2 overflow-x-auto text-xs text-slate-300">
                {JSON.stringify(record.rawPayload, null, 2)}
              </pre>
            </details>
          ) : null}
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
      <ConfirmDialog
        description={`Delete "${leadDisplayName(record) ?? 'this lead'}"? This removes the lead from your workspace.`}
        onConfirm={() => remove.mutate()}
        onOpenChange={setConfirmDelete}
        open={confirmDelete}
        pending={remove.isPending}
        title="Delete lead"
      />
    </>
  );
};
