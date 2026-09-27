import { PipelineNameDialog } from './PipelineNameDialog';
import { PipelineSection } from './PipelineSection';
import { Notice } from '@/components/Notice';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { type PipelineView } from '@/domain/schemas';
import { request } from '@/lib/http';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

export const PipelinesPage = () => {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const pipelines = useQuery({
    queryFn: () => request<PipelineView[]>('/v1/pipelines'),
    queryKey: ['pipelines'],
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['pipelines'] });
    void queryClient.invalidateQueries({ queryKey: ['leads'] });
    void queryClient.invalidateQueries({ queryKey: ['lead-stage-counts'] });
  };

  const create = useMutation({
    mutationFn: (name: string) =>
      request('/v1/pipelines', {
        body: JSON.stringify({ name }),
        method: 'POST',
      }),
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : 'Something went wrong.',
      );
    },
    onSuccess: () => {
      setShowCreate(false);
      toast.success('Pipeline created');
      invalidate();
    },
  });

  const rows = pipelines.data ?? [];
  return (
    <>
      <PageHeader
        action={
          <Button onClick={() => setShowCreate(true)}>
            <Plus size={16} /> Add pipeline
          </Button>
        }
        eyebrow="Settings"
        title="Pipelines"
      />
      <div className="grid gap-5 p-5 sm:p-8">
        {pipelines.error ? <Notice error={pipelines.error} /> : null}
        {pipelines.isPending ? (
          <p className="text-slate-400">Loading pipelines…</p>
        ) : null}
        {rows.map((pipeline) => (
          <PipelineSection
            key={pipeline.id}
            onChanged={invalidate}
            pipeline={pipeline}
          />
        ))}
        {!pipelines.isPending && rows.length === 0 && (
          <p className="text-sm text-slate-400">
            No pipelines yet. Create one to start routing leads.
          </p>
        )}
      </div>
      {showCreate && (
        <PipelineNameDialog
          onOpenChange={setShowCreate}
          onSubmit={(name) => create.mutate(name)}
          open
          pending={create.isPending}
          title="New pipeline"
        />
      )}
    </>
  );
};
