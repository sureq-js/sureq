import clsx from 'clsx'

type Tone = 'neutral' | 'active' | 'success' | 'danger' | 'muted'

const toneClasses: Record<Tone, { box: string; text: string }> = {
  neutral: {
    box: 'fill-white stroke-zinc-300 dark:fill-zinc-800 dark:stroke-zinc-600',
    text: 'fill-zinc-900 dark:fill-white',
  },
  active: {
    box: 'fill-sky-50 stroke-sky-400 dark:fill-sky-400/10 dark:stroke-sky-400/60',
    text: 'fill-sky-900 dark:fill-sky-300',
  },
  success: {
    box: 'fill-emerald-50 stroke-emerald-400 dark:fill-emerald-400/10 dark:stroke-emerald-400/60',
    text: 'fill-emerald-900 dark:fill-emerald-300',
  },
  danger: {
    box: 'fill-rose-50 stroke-rose-400 dark:fill-rose-400/10 dark:stroke-rose-400/60',
    text: 'fill-rose-900 dark:fill-rose-300',
  },
  muted: {
    box: 'fill-zinc-100 stroke-zinc-300 dark:fill-zinc-800/60 dark:stroke-zinc-600',
    text: 'fill-zinc-600 dark:fill-zinc-400',
  },
}

const BOX_HEIGHT = 44

function State({
  x,
  y,
  width,
  label,
  tone = 'neutral',
}: {
  x: number
  y: number
  width: number
  label: string
  tone?: Tone
}) {
  let classes = toneClasses[tone]
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={BOX_HEIGHT}
        rx={10}
        strokeWidth={1.5}
        className={classes.box}
      />
      <text
        x={x + width / 2}
        y={y + BOX_HEIGHT / 2}
        textAnchor="middle"
        dominantBaseline="central"
        className={clsx('font-mono text-[14px] font-semibold', classes.text)}
      >
        {label}
      </text>
    </g>
  )
}

function Arrow({ d, dashed = false }: { d: string; dashed?: boolean }) {
  return (
    <path
      d={d}
      fill="none"
      strokeWidth={1.5}
      strokeDasharray={dashed ? '5 4' : undefined}
      markerEnd="url(#job-lifecycle-arrow)"
      className="stroke-zinc-400 dark:stroke-zinc-500"
    />
  )
}

function Label({
  x,
  y,
  lines,
  anchor = 'start',
  strong = false,
}: {
  x: number
  y: number
  lines: string[]
  anchor?: 'start' | 'middle' | 'end'
  strong?: boolean
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      className={clsx(
        'text-[13px]',
        strong
          ? 'fill-zinc-900 font-medium dark:fill-white'
          : 'fill-zinc-600 dark:fill-zinc-400',
      )}
    >
      {lines.map((line, index) => (
        <tspan key={line} x={x} dy={index === 0 ? 0 : 18}>
          {line}
        </tspan>
      ))}
    </text>
  )
}

/**
 * The job state machine from `user-docs/01-getting-started/03-concepts.md`,
 * drawn in place of the ASCII version that the Markdown keeps for GitHub/npm.
 */
export function JobLifecycle() {
  return (
    <figure className="not-prose my-6 overflow-x-auto rounded-2xl bg-zinc-50 p-4 ring-1 ring-zinc-900/5 sm:p-6 dark:bg-white/2.5 dark:ring-white/10">
      <svg
        viewBox="0 0 760 490"
        role="img"
        aria-labelledby="job-lifecycle-title job-lifecycle-desc"
        className="mx-auto w-full min-w-[560px] max-w-3xl"
      >
        <title id="job-lifecycle-title">Job lifecycle</title>
        <desc id="job-lifecycle-desc">
          add puts a job in waiting; add with delay puts it in delayed. A
          delayed job moves to waiting when the delay is over. A worker claims
          a waiting job, making it active. An active job returns to waiting if
          it is released or its lease runs out (too many crashes fail it), goes
          to delayed when an attempt fails and will be retried, to completed
          when the handler returns, and to failed when no attempts are left or
          the error is not retryable. Cancel moves a waiting, delayed or active
          job to cancelled. Redrive moves a failed job back to waiting or
          delayed.
        </desc>

        <defs>
          <marker
            id="job-lifecycle-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path
              d="M 0 1 L 9 5 L 0 9 z"
              className="fill-zinc-400 dark:fill-zinc-500"
            />
          </marker>
        </defs>

        {/* Entry points */}
        <Label x={165} y={24} anchor="middle" lines={['add']} strong />
        <Arrow d="M 165 32 V 68" />
        <Label x={555} y={24} anchor="middle" lines={['add with delay']} strong />
        <Arrow d="M 555 32 V 68" />

        {/* waiting <- delayed */}
        <Arrow d="M 480 92 H 242" />
        <Label x={360} y={82} anchor="middle" lines={['delay is over']} />

        {/* waiting <-> active */}
        <Arrow d="M 130 116 V 248" />
        <Label x={118} y={186} anchor="end" lines={['claim']} />
        <Arrow d="M 200 248 V 116" />
        <Label
          x={212}
          y={168}
          lines={['released, or lease ran out', '(too many crashes: failed)']}
        />

        {/* active -> delayed */}
        <Arrow d="M 555 248 V 116" />
        <Label x={567} y={168} lines={['attempt failed,', 'retry after a wait']} />

        {/* active -> final states */}
        <Arrow d="M 135 296 V 418" />
        <Label x={147} y={352} lines={['handler', 'returned']} />
        <Arrow d="M 360 296 V 418" dashed />
        <Label x={372} y={352} lines={['cancel (also from', 'waiting or delayed)']} />
        <Arrow d="M 585 296 V 418" />
        <Label x={597} y={352} lines={['no attempts left,', 'or not retryable']} />

        {/* failed -> redrive */}
        <Arrow d="M 662 442 H 740 V 92 H 632" dashed />
        <Label x={732} y={212} anchor="end" lines={['redrive', '(to waiting or delayed)']} />

        <State x={90} y={70} width={150} label="waiting" />
        <State x={480} y={70} width={150} label="delayed" />
        <State x={90} y={250} width={540} label="active" tone="active" />
        <State x={60} y={420} width={150} label="completed" tone="success" />
        <State x={285} y={420} width={150} label="cancelled" tone="muted" />
        <State x={510} y={420} width={150} label="failed" tone="danger" />
      </svg>
    </figure>
  )
}
