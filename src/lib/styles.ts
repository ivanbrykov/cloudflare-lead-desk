export const cn = (...values: Array<false | null | string | undefined>) =>
  values.filter(Boolean).join(' ');
