/**
 * Sign-in cards: the requests the agent-login broker on a PC is waiting on from the owner, and
 * the owner's answer. The secrets in an answer go to the broker only; no agent reads them.
 */

export type SignInKind = "init" | "unlock" | "credentials" | "code";

export interface SignInRequest {
  id: string;
  kind: SignInKind;
  site: string;
  /** the saved username, where the vault knows one */
  username: string | null;
  /** the sign-in page the broker will open; null when the owner must give it */
  login_url: string | null;
  browser: string | null;
  /** who asked: user, pid and the herdr pane the CLI ran in */
  requester: string | null;
  pane: string | null;
  created: string;
  hint: string | null;
}

export interface SignInList {
  broker: "online" | "offline";
  requests: SignInRequest[];
}

/** what the broker says after the owner's answer went in and the login ran (or is still running) */
export interface SignInOutcome {
  kind: SignInKind;
  site: string;
  /** logged-in | already-logged-in | needs-owner | failed | pending */
  result: string;
  detail: string | null;
  url: string | null;
}

/** the answer form; every field optional, the broker validates per kind */
export interface SignInAnswer {
  username?: string;
  password?: string;
  totp?: string;
  passphrase?: string;
  code?: string;
  login_url?: string;
  remember?: boolean;
}
