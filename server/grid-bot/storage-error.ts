export class GridStorageError extends Error {
  constructor(public code: 'not_found' | 'conflict' | 'invariant' | 'lost_lease', message: string = code) { super(message); }
}
