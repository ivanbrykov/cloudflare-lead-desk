import { Button } from './components/ui/button';
import { Dialog } from './components/ui/dialog';
import {
  type LeadActivity,
  type LeadView,
  type PipelineView,
} from './domain/schemas';
import { request, requestBody } from './lib/http';
import { cn } from './lib/styles';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ChevronLeft, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'wouter';

type LeadPage = { data: LeadView[]; nextCursor: null | string };
type StageCount = { count: number; stageId: string };

const PageHeader = ({
  action,
  eyebrow,
  title,
}: {
  readonly action?: React.ReactNode;
  readonly eyebrow?: string;
  readonly title: string;
}) => (
  <header className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-800 px-5 py-5 sm:px-8">
    <div>
      {eyebrow && (
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-400">
          {eyebrow}
        </p>
      )}
      <h1 className="text-2xl font-semibold tracking-tight text-white">
        {title}
      </h1>
    </div>
    {action}
  </header>
);

const Notice = ({ error }: { readonly error: unknown }) => (
  <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-100">
    {error instanceof Error ? error.message : 'Something went wrong.'}
  </div>
);

const Field = ({
  children,
  label,
}: {
  readonly children: React.ReactNode;
  readonly label: string;
}) => (
  <label className="grid gap-1 text-sm text-slate-300">
    <span>{label}</span>
    {children}
  </label>
);

const inputClass =
  'rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-200';

const selectClass =
  'rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-200';

const StageChip = ({
  active,
  count,
  label,
  onClick,
}: {
  readonly active: boolean;
  readonly count: number;
  readonly label: string;
  readonly onClick: () => void;
}) => (
  <button
    className={cn(
      'rounded-full border px-3 py-1 text-xs font-medium transition',
      active
        ? 'border-cyan-400 bg-cyan-400/10 text-cyan-200'
        : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200',
    )}
    onClick={onClick}
    type="button"
  >
    {label} <span className="text-slate-500">{count}</span>
  </button>
);

const formatCustomValue = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

const CreateLeadDialog = ({
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

export const LeadsPage = () => {
  const queryClient = useQueryClient();
  const [pipelineId, setPipelineId] = useState<null | string>(null);
  const [stageId, setStageId] = useState<null | string>(null);
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkStageId, setBulkStageId] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const pipelines = useQuery({
    queryFn: () => request<PipelineView[]>('/v1/pipelines'),
    queryKey: ['pipelines'],
  });
  const activePipelines = (pipelines.data ?? []).filter(
    (item) => item.archivedAt === null,
  );
  const defaultPipelineId =
    activePipelines.find((item) => item.stages.length > 0)?.id ??
    activePipelines[0]?.id;
  const effectivePipelineId = pipelineId ?? defaultPipelineId;
  const pipeline = activePipelines.find(
    (item) => item.id === effectivePipelineId,
  );

  const counts = useQuery({
    enabled: Boolean(effectivePipelineId),
    queryFn: () =>
      request<StageCount[]>(
        `/v1/leads/stage-counts?pipelineId=${effectivePipelineId}`,
      ),
    queryKey: ['lead-stage-counts', effectivePipelineId],
  });
  const countByStage = new Map(
    (counts.data ?? []).map((entry) => [entry.stageId, entry.count]),
  );
  const allCount = [...countByStage.values()].reduce(
    (sum, value) => sum + value,
    0,
  );

  const leads = useInfiniteQuery({
    enabled: Boolean(effectivePipelineId),
    getNextPageParam: (lastPage: LeadPage) => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const parameters = new URLSearchParams();
      if (effectivePipelineId) {
        parameters.set('pipelineId', effectivePipelineId);
      }

      if (stageId) {
        parameters.set('stageId', stageId);
      }

      if (search) {
        parameters.set('query', search);
      }

      if (pageParam) {
        parameters.set('cursor', pageParam);
      }

      return requestBody<LeadPage>(`/v1/leads?${parameters.toString()}`);
    },
    queryKey: ['leads', effectivePipelineId, stageId, search],
  });
  const rows = leads.data?.pages.flatMap((page) => page.data) ?? [];

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['leads'] });
    void queryClient.invalidateQueries({ queryKey: ['lead-stage-counts'] });
  };

  const moveSelected = useMutation({
    mutationFn: (target: string) =>
      request('/v1/leads/bulk', {
        body: JSON.stringify({ ids: selected, stageId: target }),
        method: 'PATCH',
      }),
    onSuccess: () => {
      setSelected([]);
      invalidate();
    },
  });
  const deleteSelected = useMutation({
    mutationFn: () =>
      request('/v1/leads/bulk-delete', {
        body: JSON.stringify({ ids: selected }),
        method: 'POST',
      }),
    onSuccess: () => {
      setSelected([]);
      invalidate();
    },
  });
  const moveOne = useMutation({
    mutationFn: ({ id, target }: { id: string; target: string }) =>
      request(`/v1/leads/${id}`, {
        body: JSON.stringify({ stageId: target }),
        method: 'PATCH',
      }),
    onSuccess: invalidate,
  });

  const error =
    pipelines.error ??
    leads.error ??
    counts.error ??
    moveSelected.error ??
    deleteSelected.error ??
    moveOne.error;

  return (
    <>
      <PageHeader
        action={
          <Button onClick={() => setShowCreate(true)}>
            <Plus size={16} /> Add lead
          </Button>
        }
        eyebrow="Work queue"
        title="Leads"
      />
      <div className="p-5 sm:p-8">
        {error ? <Notice error={error} /> : null}
        <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-sm text-slate-400">
          <Field label="Pipeline">
            <select
              className={selectClass}
              disabled={activePipelines.length === 0}
              onChange={(event) => {
                setPipelineId(event.target.value);
                setStageId(null);
                setSelected([]);
              }}
              value={effectivePipelineId ?? ''}
            >
              {activePipelines.length === 0 && (
                <option value="">No active pipelines</option>
              )}
              {activePipelines.map((item) => (
                <option
                  key={item.id}
                  value={item.id}
                >
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(searchDraft.trim());
              setSelected([]);
            }}
          >
            <Field label="Search">
              <input
                className={inputClass}
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="Name or email"
                value={searchDraft}
              />
            </Field>
            <Button
              tone="secondary"
              type="submit"
            >
              <Search size={16} />
            </Button>
          </form>
          <div className="flex flex-wrap items-center gap-1">
            <StageChip
              active={stageId === null}
              count={allCount}
              label="All"
              onClick={() => {
                setStageId(null);
                setSelected([]);
              }}
            />
            {pipeline?.stages.map((stage) => (
              <StageChip
                active={stageId === stage.id}
                count={countByStage.get(stage.id) ?? 0}
                key={stage.id}
                label={stage.name}
                onClick={() => {
                  setStageId(stage.id);
                  setSelected([]);
                }}
              />
            ))}
          </div>
        </div>

        {selected.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3 text-sm">
            <span className="font-medium text-slate-200">
              {selected.length} selected
            </span>
            <select
              className={selectClass}
              onChange={(event) => setBulkStageId(event.target.value)}
              value={bulkStageId}
            >
              <option value="">Move to…</option>
              {pipeline?.stages.map((stage) => (
                <option
                  key={stage.id}
                  value={stage.id}
                >
                  {stage.name}
                </option>
              ))}
            </select>
            <Button
              disabled={!bulkStageId || moveSelected.isPending}
              onClick={() => moveSelected.mutate(bulkStageId)}
              tone="secondary"
            >
              Move
            </Button>
            <Button
              disabled={deleteSelected.isPending}
              onClick={() => deleteSelected.mutate()}
              tone="danger"
            >
              Delete
            </Button>
          </div>
        )}

        {leads.isPending ? (
          <p className="text-slate-400">Loading leads…</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-900 text-xs uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="w-10 px-4 py-3">
                    <input
                      checked={
                        rows.length > 0 && selected.length === rows.length
                      }
                      onChange={() =>
                        setSelected(
                          selected.length === rows.length
                            ? []
                            : rows.map((lead) => lead.id),
                        )
                      }
                      type="checkbox"
                    />
                  </th>
                  <th className="px-4 py-3">Lead</th>
                  <th className="px-4 py-3">Stage</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Value</th>
                  <th className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((lead) => (
                  <tr
                    className="border-t border-slate-800"
                    key={lead.id}
                  >
                    <td className="px-4 py-3">
                      <input
                        checked={selected.includes(lead.id)}
                        onChange={() =>
                          setSelected((current) =>
                            current.includes(lead.id)
                              ? current.filter((id) => id !== lead.id)
                              : [...current, lead.id],
                          )
                        }
                        type="checkbox"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        className="font-medium text-slate-100 hover:text-cyan-300"
                        href={`/leads/${lead.id}`}
                      >
                        {lead.name}
                      </Link>
                      {lead.duplicateCount > 0 && (
                        <span
                          className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-300"
                          title="Other leads share this email"
                        >
                          ⧉ {lead.duplicateCount}
                        </span>
                      )}
                      {lead.email && (
                        <p className="text-xs text-slate-500">{lead.email}</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <select
                        className={selectClass}
                        onChange={(event) =>
                          moveOne.mutate({
                            id: lead.id,
                            target: event.target.value,
                          })
                        }
                        value={lead.stageId}
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
                    </td>
                    <td className="px-4 py-3 text-slate-400">{lead.source}</td>
                    <td className="px-4 py-3 text-slate-400">
                      {lead.estimatedValue === null
                        ? '—'
                        : `$${lead.estimatedValue.toLocaleString()}`}
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {new Date(lead.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <p className="p-6 text-sm text-slate-400">
                No leads in this view.
              </p>
            )}
          </div>
        )}

        {leads.hasNextPage && (
          <div className="mt-4">
            <Button
              disabled={leads.isFetchingNextPage}
              onClick={() => leads.fetchNextPage()}
              tone="secondary"
            >
              {leads.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </div>
      {showCreate && (
        <CreateLeadDialog
          onOpenChange={setShowCreate}
          pipeline={pipeline}
        />
      )}
    </>
  );
};

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
    estimatedValue: string;
    name: string;
    source: string;
  }>(null);

  const record = lead.data;
  const currentDraft =
    draft ??
    (record
      ? {
          estimatedValue:
            record.estimatedValue === null ? '' : String(record.estimatedValue),
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
          estimatedValue:
            currentDraft && currentDraft.estimatedValue.trim() === ''
              ? null
              : Number(currentDraft?.estimatedValue),
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
            <Field label="Name">
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
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Email</dt>
              <dd className="text-slate-200">{record.email ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Contact</dt>
              <dd className="text-slate-200">
                {[record.firstName, record.lastName]
                  .filter(Boolean)
                  .join(' ') || '—'}
              </dd>
            </div>
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
