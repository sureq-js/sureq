import type { ConfigIssue } from './catalog.js';

/**
 * Human-readable message for an InvalidOptionError:
 *   Invalid SureQ configuration for Queue "emails" (2 problems):
 *     - backoff.jiter: unknown option (did you mean "jitter"?)
 *     - concurrency: expected integer >= 1, received 0
 */
export function formatIssues(scope: string, issues: readonly ConfigIssue[]): string {
  const count = issues.length === 1 ? '1 problem' : `${issues.length} problems`;
  const lines = issues.map((i) => `  - ${i.path === '' ? '(options)' : i.path}: ${i.message}`);
  return [`Invalid SureQ configuration for ${scope} (${count}):`, ...lines].join('\n');
}
