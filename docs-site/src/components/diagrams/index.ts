import { JobLifecycle } from '@/components/diagrams/JobLifecycle'

/**
 * Diagrams drawn in place of ASCII art. A Markdown fence opts in with
 * ` ```text diagram=<name> `; GitHub and npm still show the ASCII version.
 */
export const diagrams: Record<string, React.ComponentType> = {
  'job-lifecycle': JobLifecycle,
}
