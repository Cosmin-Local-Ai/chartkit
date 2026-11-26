/**
 * The Node-only surface the test suites reach for. The app itself is DOM-only, so the
 * project carries no `@types/node`; this declares just what the tests read.
 */

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
