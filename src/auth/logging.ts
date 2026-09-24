// Better Auth's default logger prints error objects, which can include SQL
// parameters such as session tokens. Keep only the severity and cause class.
export const logAuthMessage = (level: string, ...parts: unknown[]): void => {
  if (level !== 'error' && level !== 'warn') {
    return;
  }

  const cause = parts.find((part): part is Error => part instanceof Error);
  const line = JSON.stringify({
    errorClass: cause?.constructor.name,
    event: 'auth.library',
    level,
  });
  if (level === 'error') {
    // eslint-disable-next-line no-console -- This is the sanitized Worker log sink.
    console.error(line);
  } else {
    // eslint-disable-next-line no-console -- This is the sanitized Worker log sink.
    console.warn(line);
  }
};
