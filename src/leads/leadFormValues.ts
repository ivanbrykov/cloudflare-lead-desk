// Form values and request mappers for lead create/update.
//
// The dialog/detail forms hold everything as strings (that is what inputs
// produce); the API contract is typed and distinguishes "empty" from "null"
// differently for create and update. These mappers are the single place that
// conversion happens, and tests decode their output through the Effect
// request schemas so the client cannot drift from the contract.

export type LeadFormValues = {
  email: string;
  estimatedValue: string;
  firstName: string;
  lastName: string;
  source: string;
};

export const emptyLeadFormValues: LeadFormValues = {
  email: '',
  estimatedValue: '',
  firstName: '',
  lastName: '',
  source: 'Website',
};

const trimmedOrUndefined = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

export const toCreateLeadInput = (values: LeadFormValues) => ({
  email: trimmedOrUndefined(values.email),
  estimatedValue:
    values.estimatedValue.trim() === ''
      ? undefined
      : Number(values.estimatedValue),
  firstName: trimmedOrUndefined(values.firstName),
  lastName: trimmedOrUndefined(values.lastName),
  source: trimmedOrUndefined(values.source),
});
