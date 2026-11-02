import type { QueryResult } from '../types/index.ts';

export function resultSetList(result: QueryResult): QueryResult[] {
  return [result, ...(result.result_sets ?? [])];
}
