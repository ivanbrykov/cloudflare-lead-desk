export const PageHeader = ({
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
