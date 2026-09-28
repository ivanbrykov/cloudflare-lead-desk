export const Field = ({
  children,
  hint,
  label,
}: {
  readonly children: React.ReactNode;
  readonly hint?: string;
  readonly label: string;
}) => (
  <label className="grid gap-1 text-sm text-slate-300">
    <span>{label}</span>
    {hint ? <span className="text-xs text-slate-500">{hint}</span> : null}
    {children}
  </label>
);
