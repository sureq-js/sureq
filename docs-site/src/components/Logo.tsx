const base = import.meta.env.BASE_URL

// The SureQ logo: "Sure" plus the Q whose tail is a check mark. Sources and rules live in brand/.
export function Logo({ className }: { className?: string }) {
  return (
    <>
      <img
        src={`${base}sureq-horizontal.svg`}
        alt="SureQ"
        className={`w-auto dark:hidden ${className ?? ''}`}
      />
      <img
        src={`${base}sureq-horizontal-reversed.svg`}
        alt="SureQ"
        className={`hidden w-auto dark:block ${className ?? ''}`}
      />
    </>
  )
}
