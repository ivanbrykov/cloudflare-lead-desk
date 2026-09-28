import { CreateLeadDialog } from './CreateLeadDialog';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Notice } from '@/components/Notice';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { inputClass } from '@/components/ui/form';
import { type LeadView } from '@/domain/schemas';
import { request, requestBody } from '@/lib/http';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'wouter';

type LeadPage = { data: LeadView[]; nextCursor: null | string };

export const LeadsPage = () => {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const leads = useInfiniteQuery({
    getNextPageParam: (lastPage: LeadPage) => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const parameters = new URLSearchParams();
      if (search) {
        parameters.set('query', search);
      }

      if (pageParam) {
        parameters.set('cursor', pageParam);
      }

      return requestBody<LeadPage>(`/v1/leads?${parameters.toString()}`);
    },
    queryKey: ['leads', search],
  });
  const rows = leads.data?.pages.flatMap((page) => page.data) ?? [];

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['leads'] });
  };

  const deleteSelected = useMutation({
    mutationFn: async () => {
      // Select-all can load more than the API's 100-id bulk limit, so send
      // the selection in chunks instead of failing validation.
      for (let index = 0; index < selected.length; index += 100) {
        await request('/v1/leads/bulk-delete', {
          body: JSON.stringify({ ids: selected.slice(index, index + 100) }),
          method: 'POST',
        });
      }
    },
    onSuccess: () => {
      toast.success(
        `${selected.length} ${selected.length === 1 ? 'lead' : 'leads'} deleted`,
      );
      setSelected([]);
      setConfirmDelete(false);
      invalidate();
    },
  });

  const error = leads.error ?? deleteSelected.error;

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
        </div>

        {selected.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3 text-sm">
            <span className="font-medium text-slate-200">
              {selected.length} selected
            </span>
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
                No leads yet. Add one manually or send an intake submission.
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
      {showCreate && <CreateLeadDialog onOpenChange={setShowCreate} />}
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
