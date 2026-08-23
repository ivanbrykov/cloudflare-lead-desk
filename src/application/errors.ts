import { Data } from 'effect';

export class DomainError extends Data.TaggedError('DomainError')<{
  code: string;
  details?: unknown;
  message: string;
}> {}

export class PersistenceError extends Data.TaggedError('PersistenceError')<{
  cause: unknown;
}> {}
