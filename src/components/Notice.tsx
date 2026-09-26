export const Notice = ({ error }: { readonly error: unknown }) => (
  <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-100">
    {error instanceof Error ? error.message : 'Something went wrong.'}
  </div>
);
