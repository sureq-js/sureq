import { Button } from '@/components/Button'
import { HeroPattern } from '@/components/HeroPattern'

export function HomeHero() {
  return (
    <>
      <HeroPattern />
      <h1 className="text-4xl font-bold tracking-tight text-zinc-900 sm:text-5xl dark:text-white">
        SureQ documentation
      </h1>
      <p className="lead mt-6 text-lg text-zinc-600 dark:text-zinc-400">
        A job queue for Node.js, written in TypeScript. Add jobs to a queue, and
        workers run them with retries, delays, priorities and schedules.
      </p>
      <div className="not-prose mt-6 mb-16 flex gap-3">
        <Button href="/getting-started/install" arrow="right">
          Install SureQ
        </Button>
        <Button href="/getting-started/first-queue" variant="outline">
          Your first queue
        </Button>
      </div>
    </>
  )
}