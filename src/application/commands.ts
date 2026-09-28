import { DomainError, PersistenceError } from './errors';
import {
  createLead,
  createLeadActivity,
  createLeadAtomically,
  type Env,
  getIntakeKey,
  type IntakePersistenceOutcome,
  outcomeForStoredIntakeKey,
  softDeleteLeads,
  updateLead,
} from '@/db/repository';
import { intakeRequestFingerprint } from '@/domain/intake';
import {
  type CreateLeadInput,
  type IntakeInput,
  type UpdateLeadInput,
} from '@/domain/schemas';
import { Effect } from 'effect';

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

export const createIntakeCommand = (
  environment: Env,
  input: IntakeInput,
  idempotencyKey: string,
  provenance?: { origin: null | string; publicKeyId: null | string },
) =>
  Effect.gen(function* () {
    // Request identity: a pure fingerprint of the static-schema-decoded input.
    // No mutable workspace lookup may influence it, so a retry is recognized
    // regardless of later edits elsewhere.
    const requestHash = yield* Effect.tryPromise({
      catch: (cause) => new PersistenceError({ cause }),
      try: () => intakeRequestFingerprint(input),
    });
    const stored = yield* persist(() =>
      getIntakeKey(environment, idempotencyKey),
    );
    const storedOutcome = outcomeForStoredIntakeKey(stored, requestHash);
    if (storedOutcome) {
      return storedOutcome;
    }

    return yield* persist((): Promise<IntakePersistenceOutcome> =>
      createLeadAtomically(
        environment,
        input,
        idempotencyKey,
        requestHash,
        provenance,
      ),
    );
  });

export const createLeadCommand = (environment: Env, input: CreateLeadInput) =>
  Effect.gen(function* () {
    yield* validate(() => {
      if (!input.email && !input.firstName && !input.lastName) {
        throw new DomainError({
          code: 'lead_identity_required',
          message: 'Enter an email, first name, or last name.',
        });
      }
    });

    return yield* persist(() => createLead(environment, input));
  });

export const updateLeadCommand = (
  environment: Env,
  leadId: string,
  input: UpdateLeadInput,
) => persist(() => updateLead(environment, leadId, input));

export const softDeleteLeadsCommand = (
  environment: Env,
  ids: readonly string[],
) => persist(() => softDeleteLeads(environment, ids));

export const createLeadActivityCommand = (
  environment: Env,
  leadId: string,
  actorEmail: string,
  kind: string,
  body: string,
) =>
  persist(() =>
    createLeadActivity(environment, leadId, actorEmail, kind, body),
  );
