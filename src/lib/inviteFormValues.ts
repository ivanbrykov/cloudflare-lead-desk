import { localDateTimeToIso } from './datetime';

export type InviteFormValues = {
  expiration: string;
  name: string;
};

export const emptyInviteFormValues = (
  defaultExpiration: string,
): InviteFormValues => ({
  expiration: defaultExpiration,
  name: '',
});

export const toCreateInviteInput = (values: InviteFormValues) => ({
  expiresAt: localDateTimeToIso(values.expiration),
  name: values.name.trim(),
});
