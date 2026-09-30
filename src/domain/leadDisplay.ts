/**
 * Label for a lead in lists and headers.
 *
 * Leads have no title column: the label is derived from the person's name and
 * falls back to the email. A null result tells the UI to render its own
 * dimmed placeholder.
 */
export type LeadDisplayFields = {
  email: null | string;
  firstName: null | string;
  lastName: null | string;
};

export const leadDisplayName = (lead: LeadDisplayFields): null | string => {
  const person = [lead.firstName, lead.lastName]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part !== '')
    .join(' ');
  return person || lead.email || null;
};
