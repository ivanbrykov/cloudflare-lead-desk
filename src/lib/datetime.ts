// Wall-clock helpers for datetime-local inputs.

// datetime-local inputs only carry local wall-clock time, so shift the
// instant into local parts before handing it to the input element.
export const toLocalInputValue = (date: Date): string =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);

// The input value is local wall-clock time; new Date parses it as local time
// and toISOString converts it to the UTC ISO string the API expects. An empty
// input means "use the server default" and maps to undefined.
export const localDateTimeToIso = (value: string): string | undefined => {
  if (value === '') {
    return undefined;
  }

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};

export const isFutureLocalDateTime = (value: string): boolean => {
  if (value === '') {
    return false;
  }

  const time = new Date(value).getTime();
  return Number.isFinite(time) && time > Date.now();
};
