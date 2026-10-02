export const Field = ({
  children,
  error,
  hint,
  label,
}: {
  readonly children: React.ReactNode;
  readonly error?: string;
  readonly hint?: string;
  readonly label: string;
}) => (
  <label className="grid gap-1 text-sm text-slate-300">
    <span>{label}</span>
    {hint ? <span className="text-xs text-slate-500">{hint}</span> : null}
    {children}
    {error ? (
      <span
        className="text-xs text-rose-300"
        role="alert"
      >
        {error}
      </span>
    ) : null}
  </label>
);
