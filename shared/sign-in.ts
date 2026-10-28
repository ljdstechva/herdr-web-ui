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
  /** why a credentials card asks: the site refused the saved login, or the owner is changing it; null for a first sign-in */
  reason: "rejected" | "change" | null;
}

export interface SignInList {
  broker: "online" | "offline";
  requests: SignInRequest[];
}

/** what the broker says after the owner's answer went in and the login ran (or is still running) */
export interface SignInOutcome {
  kind: SignInKind;
  site: string;
  /** logged-in | already-logged-in | rejected | needs-owner | failed | pending; saved | unlocked for a card the owner opened from Settings */
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

/** one site the vault holds a login for (never its password) */
export interface SignInSite {
  site: string;
  username: string;
  browser: string | null;
  login_url: string | null;
  /** when the login was last used successfully; null when never */
  last_login: string | null;
  /** when it was last replaced from a card; null when never */
  updated: string | null;
}

/** Settings → Website logins: what the broker keeps, by name only */
export interface SignInSites {
  broker: "online" | "offline";
  /** a vault exists on this PC */
  vault: boolean;
  /** the vault is locked (after a reboot): the names are hidden until the owner unlocks it */
  locked: boolean;
  sites: SignInSite[] | null;
  /** sites the broker knows a login flow for but holds no login of yet */
  known: string[];
}
