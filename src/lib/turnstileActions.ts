/** Stable action names shared by each widget and its matching backend gate. */
export const TURNSTILE_ACTIONS = {
  login: "login",
  setup: "setup",
  passwordForgot: "password_forgot",
  passwordReset: "password_reset",
  invitationAccept: "invitation_accept",
} as const;

export type TurnstileAction = (typeof TURNSTILE_ACTIONS)[keyof typeof TURNSTILE_ACTIONS];
