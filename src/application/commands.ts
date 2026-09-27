import { DomainError, PersistenceError } from './errors';
import {
  createLead,
  createLeadActivity,
  createLeadAtomically,
  createPipeline,
  createStage,
  DEFAULT_PIPELINE_ID,
  DEFAULT_STAGE_ID,
  deleteStage,
  type Env,
  getIntakeKey,
  getPipeline,
  type IntakePersistenceOutcome,
  intakePipelineId,
  intakeStageId,
  isActivePipelineNameTaken,
  isStageInActiveWorkspacePipeline,
  moveLeads,
  outcomeForStoredIntakeKey,
  reorderStages,
  softDeleteLeads,
  updateLead,
  updatePipeline,
  updateStage,
} from '@/db/repository';
import { intakeRequestFingerprint } from '@/domain/intake';
import {
  type CreateLeadInput,
  type IntakeInput,
  type ReorderStagesInput,
  type UpdateLeadInput,
  type UpdatePipelineInput,
  type UpdateStageInput,
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
) =>
  Effect.gen(function* () {
    // Request identity: a pure fingerprint of the static-schema-decoded input.
    // No field-definition or pipeline lookup may influence it, so mutable
    // workspace state can never change whether a retry is recognized.
    const requestHash = yield* Effect.tryPromise({
      catch: (cause) => new PersistenceError({ cause }),
      try: () => intakeRequestFingerprint(input),
    });
    // Replay/conflict/legacy checks run BEFORE current pipeline validation,
    // so an accepted submission keeps replaying after its pipeline is archived.
    const stored = yield* persist(() =>
      getIntakeKey(environment, idempotencyKey),
    );
    const storedOutcome = outcomeForStoredIntakeKey(stored, requestHash);
    if (storedOutcome) {
      return storedOutcome;
    }

    // Mutable application rules apply to NEW submissions only.
    const routingValid = yield* persist(() =>
      isStageInActiveWorkspacePipeline(
        environment,
        intakePipelineId(input),
        intakeStageId(input),
      ),
    );
    if (!routingValid) {
      return yield* Effect.fail(
        new DomainError({
          code: 'invalid_stage',
          message:
            'The selected stage must belong to the selected pipeline, both must be active in this workspace.',
        }),
      );
    }

    return yield* persist((): Promise<IntakePersistenceOutcome> =>
      createLeadAtomically(environment, input, idempotencyKey, requestHash),
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
    const routingValid = yield* persist(() =>
      isStageInActiveWorkspacePipeline(
        environment,
        input.pipelineId ?? DEFAULT_PIPELINE_ID,
        input.stageId ?? DEFAULT_STAGE_ID,
      ),
    );
    if (!routingValid) {
      return yield* Effect.fail(
        new DomainError({
          code: 'invalid_stage',
          message:
            'The selected stage must belong to the selected pipeline, both must be active in this workspace.',
        }),
      );
    }

    return yield* persist(() => createLead(environment, input));
  });

export const updateLeadCommand = (
  environment: Env,
  leadId: string,
  input: UpdateLeadInput,
) => persist(() => updateLead(environment, leadId, input));

export const moveLeadsCommand = (
  environment: Env,
  ids: readonly string[],
  stageId: string,
) => persist(() => moveLeads(environment, ids, stageId));

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

export const createPipelineCommand = (environment: Env, name: string) =>
  Effect.gen(function* () {
    const taken = yield* persist(() =>
      isActivePipelineNameTaken(environment, name),
    );
    if (taken) {
      return yield* Effect.fail(
        new DomainError({
          code: 'pipeline_name_taken',
          message: 'An active pipeline with this name already exists.',
        }),
      );
    }

    return yield* persist(() => createPipeline(environment, name));
  });

export const updatePipelineCommand = (
  environment: Env,
  pipelineId: string,
  input: UpdatePipelineInput,
) =>
  Effect.gen(function* () {
    // Renaming and unarchiving both put a name into the active namespace, so
    // either must check it against the active pipelines (excluding self).
    if (input.name !== undefined || input.archived === false) {
      const existing = yield* persist(() =>
        getPipeline(environment, pipelineId),
      );
      if (existing === null) {
        return yield* Effect.fail(
          new DomainError({
            code: 'not_found',
            message: 'Pipeline not found.',
          }),
        );
      }

      const name = input.name ?? existing.name;
      const taken = yield* persist(() =>
        isActivePipelineNameTaken(environment, name, pipelineId),
      );
      if (taken) {
        return yield* Effect.fail(
          new DomainError({
            code: 'pipeline_name_taken',
            message: 'An active pipeline with this name already exists.',
          }),
        );
      }
    }

    const pipeline = yield* persist(() =>
      updatePipeline(environment, pipelineId, input),
    );
    if (pipeline === null) {
      return yield* Effect.fail(
        new DomainError({ code: 'not_found', message: 'Pipeline not found.' }),
      );
    }

    return pipeline;
  });

export const createStageCommand = (
  environment: Env,
  pipelineId: string,
  input: { color?: string; name: string },
) => persist(() => createStage(environment, pipelineId, input));

export const updateStageCommand = (
  environment: Env,
  pipelineId: string,
  stageId: string,
  input: UpdateStageInput,
) => persist(() => updateStage(environment, pipelineId, stageId, input));

export const reorderStagesCommand = (
  environment: Env,
  pipelineId: string,
  input: ReorderStagesInput,
) => persist(() => reorderStages(environment, pipelineId, input.stageIds));

export const deleteStageCommand = (
  environment: Env,
  pipelineId: string,
  stageId: string,
) => persist(() => deleteStage(environment, pipelineId, stageId));
