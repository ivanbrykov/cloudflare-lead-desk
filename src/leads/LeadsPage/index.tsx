import { CreateLeadDialog } from './CreateLeadDialog';
import { StageChip } from './StageChip';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Notice } from '@/components/Notice';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { inputClass, selectClass } from '@/components/ui/form';
import { type LeadView, type PipelineView } from '@/domain/schemas';
import { request, requestBody } from '@/lib/http';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'wouter';

type LeadPage = { data: LeadView[]; nextCursor: null | string };

type StageCount = { count: number; stageId: string };

export const LeadsPage = () => {
  const queryClient = useQueryClient();
  const [pipelineId, setPipelineId] = useState<null | string>(null);
  const [stageId, setStageId] = useState<null | string>(null);
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkStageId, setBulkStageId] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

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

  const stageName = (target: string) =>
    pipeline?.stages.find((stage) => stage.id === target)?.name ?? 'stage';

  const moveSelected = useMutation({
    mutationFn: (target: string) =>
      request('/v1/leads/bulk', {
        body: JSON.stringify({ ids: selected, stageId: target }),
        method: 'PATCH',
      }),
    onSuccess: (_data, target) => {
      toast.success(
        `${selected.length} ${selected.length === 1 ? 'lead' : 'leads'} moved to ${stageName(target)}`,
      );
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
      toast.success(
        `${selected.length} ${selected.length === 1 ? 'lead' : 'leads'} deleted`,
      );
      setSelected([]);
      setConfirmDelete(false);
      invalidate();
    },
  });
  const moveOne = useMutation({
    mutationFn: ({ id, target }: { id: string; target: string }) =>
      request(`/v1/leads/${id}`, {
        body: JSON.stringify({ stageId: target }),
        method: 'PATCH',
      }),
    onSuccess: (_data, variables) => {
      toast.success(`Moved to ${stageName(variables.target)}`);
      invalidate();
    },
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
              onClick={() => setConfirmDelete(true)}
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
      <ConfirmDialog
        description={`Delete ${selected.length} ${selected.length === 1 ? 'lead' : 'leads'}? This removes them from your workspace.`}
        onConfirm={() => deleteSelected.mutate()}
        onOpenChange={setConfirmDelete}
        open={confirmDelete}
        pending={deleteSelected.isPending}
        title={`Delete ${selected.length === 1 ? 'lead' : 'leads'}`}
      />
    </>
  );
};
