import { Effect } from 'effect';
import { DomainError, PersistenceError } from './errors';
import {
  createActivity,
  createContact,
  createFieldDefinition,
  createIntakeAtomically,
  createPipeline,
  createStage,
  getFieldDefinitions,
  moveOpportunity,
  type Env,
} from '@/db/repository';
import { validateCustomFields } from '@/domain/custom-fields';
import type {
  ContactInput,
  CreateCustomField,
  IntakeInput,
} from '@/domain/schemas';

const persist = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new PersistenceError({ cause }),
    try: operation,
  });

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
    const definitions = yield* persist(() => getFieldDefinitions(env, 'contact'));
    const fields = yield* validate(() =>
      validateCustomFields('contact', definitions, input.customFields),
    );
    return yield* persist(() => createContact(env, input, fields));
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
