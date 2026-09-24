/** Turnstile is on unless this deployment explicitly opts out. */
export function turnstileEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.TURNSTILE_ENABLED !== "false";
}
