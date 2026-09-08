import { Effect } from 'effect';
import { DomainError, PersistenceError } from './errors';
import {
  createActivity,
  createContact,
  deleteContact,
  createManualOpportunity,
  createFieldDefinition,
  createIntakeAtomically,
  createPipeline,
  createStage,
  getContact,
  getFieldDefinitions,
  moveOpportunity,
  updateContact,
  type Env,
} from '@/db/repository';
import { validateCustomFields } from '@/domain/custom-fields';
import type {
  ContactInput,
  CreateCustomField,
  CreateOpportunityInput,
  IntakeInput,
} from '@/domain/schemas';

const persist = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new PersistenceError({ cause }),
    try: operation,
  });

const validateContactIdentity = (input: ContactInput): void => {
  if (input.email || input.firstName || input.lastName) return;
  throw new DomainError({
    code: 'contact_identity_required',
    message: 'Enter a first name, last name, or email address.',
  });
};

const validate = <A>(operation: () => A) =>
  Effect.try({
    catch: (cause) =>
      cause instanceof DomainError
        ? cause
        : new DomainError({
            code: 'invalid_input',
            message: 'The submitted data is invalid.',
          }),
    try: operation,
  });

export const createContactCommand = (
  env: Env,
  input: ContactInput,
) =>
  Effect.gen(function* () {
    yield* validate(() => validateContactIdentity(input));
    const definitions = yield* persist(() => getFieldDefinitions(env, 'contact'));
    const fields = yield* validate(() =>
      validateCustomFields('contact', definitions, input.customFields),
    );
    return yield* persist(() => createContact(env, input, fields));
  });

export const updateContactCommand = (
  env: Env,
  contactId: string,
  input: ContactInput,
) =>
  Effect.gen(function* () {
    yield* validate(() => validateContactIdentity(input));
    const editingCustomFields = input.customFields !== undefined;
    // Custom fields on update are PATCH-like: omitted keys keep their stored
    // values. A required field therefore only fails when the contact has no
    // stored value to fall back on, so validation needs the existing values.
    const existing = editingCustomFields
      ? yield* persist(() => getContact(env, contactId))
      : null;
    const definitions = editingCustomFields && existing
      ? yield* persist(() => getFieldDefinitions(env, 'contact'))
      : [];
    const fields = editingCustomFields && existing
      ? yield* validate(() =>
          validateCustomFields(
            'contact',
            definitions,
            input.customFields,
            'update',
            new Set(Object.keys(existing.customFields)),
          ),
        )
      : [];
    return yield* persist(() => updateContact(env, contactId, input, fields));
  });

export const deleteContactCommand = (env: Env, contactId: string) =>
  persist(() => deleteContact(env, contactId));

export const createManualOpportunityCommand = (
  env: Env,
  input: CreateOpportunityInput,
  actorEmail: string,
) =>
  Effect.gen(function* () {
    if (Boolean(input.contact) === Boolean(input.contactId)) {
      return yield* Effect.fail(new DomainError({
        code: 'contact_required',
        message: 'Select an existing contact or provide a new contact.',
      }));
    }
    if (input.contact) yield* validate(() => validateContactIdentity(input.contact!));
    const contactDefinitions = input.contact
      ? yield* persist(() => getFieldDefinitions(env, 'contact'))
      : [];
    const opportunityDefinitions = yield* persist(() => getFieldDefinitions(env, 'opportunity'));
    const contactFields = input.contact
      ? yield* validate(() =>
          validateCustomFields('contact', contactDefinitions, input.contact?.customFields),
        )
      : [];
    const opportunityFields = yield* validate(() =>
      validateCustomFields('opportunity', opportunityDefinitions, input.customFields),
    );
    return yield* persist(() =>
      createManualOpportunity(env, input, contactFields, opportunityFields, actorEmail),
    );
  });

export const createIntakeCommand = (
  env: Env,
  input: IntakeInput,
  idempotencyKey: string,
) =>
  Effect.gen(function* () {
    const contactDefinitions = yield* persist(() =>
      getFieldDefinitions(env, 'contact'),
    );
    const opportunityDefinitions = yield* persist(() =>
      getFieldDefinitions(env, 'opportunity'),
    );
    const contactFields = yield* validate(() =>
      validateCustomFields('contact', contactDefinitions, input.contact.customFields),
    );
    const opportunityFields = yield* validate(() =>
      validateCustomFields(
        'opportunity',
        opportunityDefinitions,
        input.opportunity.customFields,
      ),
    );
    return yield* persist(() =>
      createIntakeAtomically(
        env,
        input,
        contactFields,
        opportunityFields,
        idempotencyKey,
      ),
    );
  });

export const createCustomFieldCommand = (
  env: Env,
  input: CreateCustomField,
) => persist(() => createFieldDefinition(env, input));

export const createPipelineCommand = (env: Env, name: string) =>
  persist(() => createPipeline(env, name));

export const createStageCommand = (
  env: Env,
  pipelineId: string,
  input: { color?: string; name: string; position?: number },
) => persist(() => createStage(env, pipelineId, input));

export const moveOpportunityCommand = (
  env: Env,
  opportunityId: string,
  stageId: string,
  actorEmail: string,
) => persist(() => moveOpportunity(env, opportunityId, stageId, actorEmail));

export const createActivityCommand = (
  env: Env,
  opportunityId: string,
  actorEmail: string,
  kind: string,
  body: string,
) => persist(() => createActivity(env, opportunityId, actorEmail, kind, body));
