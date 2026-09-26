export const Field = ({
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
