import { useEffect, useRef, useState } from "react";
import { KeyRound, LockKeyhole, Send } from "lucide-react";
import type { SignInOutcome, SignInRequest } from "../../shared/sign-in.ts";
import { answerSignIn, dismissSignIn } from "../lib/api.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { useSignInRequests } from "../lib/signIn.ts";
import "./SignInCard.css";

/** how long the outcome of an answered card stays on screen */
const OUTCOME_MS = 12_000;

function outcomeText(t: Translate, outcome: SignInOutcome): string {
  const site = outcome.site;
  switch (outcome.result) {
    case "logged-in": return t("Signed in to {site}.", { site });
    case "already-logged-in": return t("{site} was already signed in.", { site });
    case "pending": return t("The sign-in to {site} is still running; the agent will report it.", { site });
    case "needs-owner": return t("{site} still needs you: {detail}", { site, detail: outcome.detail ?? "" });
    default: return t("Sign-in to {site} failed: {detail}", { site, detail: outcome.detail ?? "" });
  }
}

/**
 * One sign-in request as a form. The secret fields are DOM-only: never React state, drafts or
 * the queue, and cleared when the page hides. Submit sends them once to this PC's broker.
 */
function SignInCard({ request, onAnswering, onOutcome }: { request: SignInRequest; onAnswering: (request: SignInRequest) => void; onOutcome: (id: string, outcome: SignInOutcome) => void }) {
  const t = useT();
  const form = useRef<HTMLFormElement>(null);
  const alive = useRef(true);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);
  useEffect(() => {
    alive.current = true;
    const clear = () => form.current?.querySelectorAll<HTMLInputElement>("input[type=password]").forEach((input) => { input.value = ""; });
    const hidden = () => { if (document.hidden) clear(); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", clear);
    return () => { alive.current = false; clear(); document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", clear); };
  }, []);
  const kind = request.kind;
  const title = kind === "init" ? t("Create the credential vault")
    : kind === "unlock" ? t("Unlock the credential vault")
    : kind === "code" ? t("Code for {site}", { site: request.site })
    : t("Sign in to {site}", { site: request.site });
  const note = kind === "init" ? t("Choose a passphrase. You type it once after each reboot; agents never see it.")
    : kind === "unlock" ? t("After a reboot the vault is locked. Your passphrase unlocks it for this PC's agents, without showing them any password.")
    : kind === "code" ? t("The site asked for a one-time code. It goes straight to the browser; the agent does not see it.")
    : t("An agent needs {site} signed in. The login goes to this PC's sign-in broker and into the browser; the agent never sees it.", { site: request.site });
  const field = (name: string) => form.current?.elements.namedItem(name) as HTMLInputElement | null;
  const take = (name: string): string => { const input = field(name); if (!input) return ""; const value = input.value; if (input.type === "password") input.value = ""; return value; };
  return <form ref={form} className="sign-in-card" aria-label={title} onSubmit={(event) => {
    event.preventDefault();
    if (busy.current) return;
    const answer = kind === "init" || kind === "unlock" ? { passphrase: take("passphrase") }
      : kind === "code" ? { code: take("code").trim() }
      : { username: take("username").trim(), password: take("password"), totp: take("totp").trim(), login_url: request.login_url === null ? take("login_url").trim() : undefined, remember };
    if (kind === "init" && (answer.passphrase ?? "").length < 8) { setError(t("Use at least 8 characters.")); return; }
    if (kind === "credentials" && (answer.username === "" || answer.password === "")) { setError(t("Enter the username and the password.")); return; }
    if (kind === "credentials" && request.login_url === null && !/^https?:\/\/\S+$/.test(answer.login_url ?? "")) { setError(t("Give the full address of the sign-in page, starting with https://")); return; }
    busy.current = true; setPending(true); setError(null);
    // the broker drops the request from its list the moment it accepts the answer: the card is
    // held on screen by the parent until the login's outcome is back
    onAnswering(request);
    void answerSignIn(request.id, answer).then((outcome) => {
      onOutcome(request.id, outcome);
    }, (reason: unknown) => {
      onOutcome(request.id, { kind, site: request.site, result: "failed", detail: t("Could not send it: {message}", { message: reason instanceof Error ? reason.message : String(reason) }), url: null });
    }).finally(() => { busy.current = false; if (alive.current) setPending(false); });
  }}>
    <p className="sign-in-card-title">{kind === "credentials" ? <KeyRound size={16} aria-hidden="true" /> : <LockKeyhole size={16} aria-hidden="true" />} {title}</p>
    <p className="sign-in-card-note">{pending ? t("Signing in…") : request.hint ?? note}</p>
    {pending ? null : <>
    {(kind === "init" || kind === "unlock") && <label className="sign-in-card-field">{t("Vault passphrase")}
      <input name="passphrase" className="input" type="password" autoComplete={kind === "init" ? "new-password" : "current-password"} autoCapitalize="none" spellCheck={false} maxLength={4096} disabled={pending} autoFocus />
    </label>}
    {kind === "credentials" && <>
      {request.login_url === null && <label className="sign-in-card-field">{t("Sign-in page address")}
        <input name="login_url" className="input" type="url" inputMode="url" autoComplete="url" autoCapitalize="none" spellCheck={false} placeholder="https://" maxLength={2048} disabled={pending} />
      </label>}
      <label className="sign-in-card-field">{t("Username or e-mail")}
        <input name="username" className="input" type="text" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} defaultValue={request.username ?? ""} maxLength={512} disabled={pending} autoFocus={request.login_url !== null} />
      </label>
      <label className="sign-in-card-field">{t("Password")}
        <input name="password" className="input" type="password" autoComplete="current-password" autoCapitalize="none" spellCheck={false} maxLength={4096} disabled={pending} />
      </label>
      <label className="sign-in-card-field">{t("Authenticator secret (optional)")}
        <input name="totp" className="input" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={256} disabled={pending} />
      </label>
      <label className="sign-in-card-check"><input type="checkbox" checked={remember} disabled={pending} onChange={(event) => setRemember(event.target.checked)} /> {t("Remember in the vault for next time")}</label>
    </>}
    {kind === "code" && <label className="sign-in-card-field">{t("One-time code")}
      <input name="code" className="input" type="text" inputMode="numeric" autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} maxLength={16} disabled={pending} autoFocus />
    </label>}
    {request.requester !== null && <p className="sign-in-card-who">{t("Asked by {who}", { who: request.requester })}</p>}
    <div className="sign-in-card-actions">
      <button type="submit" className="btn btn-primary"><Send size={14} aria-hidden="true" /> {kind === "code" ? t("Send code") : kind === "credentials" ? t("Sign in") : t("Unlock")}</button>
      <button type="button" className="btn" onClick={() => { void dismissSignIn(request.id).catch(() => { /* gone already */ }); }}>{t("Not now")}</button>
    </div>
    {error && <p className="sign-in-card-error" role="status">{error}</p>}
    </>}
  </form>;
}

/**
 * Every open sign-in request of this PC's broker, as cards over the message box, and the outcome
 * of each answered one for a moment after. Mounted in the chat lens of a local pane only.
 */
export function SignInCards({ paneId }: { paneId: string }) {
  const t = useT();
  const { requests } = useSignInRequests(true);
  /** answered cards, kept while their login runs: the broker's list no longer has them */
  const [held, setHeld] = useState<SignInRequest[]>([]);
  const [outcomes, setOutcomes] = useState<Array<{ id: string; outcome: SignInOutcome }>>([]);
  useEffect(() => {
    if (outcomes.length === 0) return;
    const timer = setTimeout(() => setOutcomes((previous) => previous.slice(1)), OUTCOME_MS);
    return () => clearTimeout(timer);
  }, [outcomes]);
  const open = new Set(requests.map((request) => request.id));
  // the pane that asked comes first; the rest follow, since one phone answers for every pane
  const ordered = [...requests, ...held.filter((request) => !open.has(request.id))].sort((a, b) => Number(b.pane === paneId) - Number(a.pane === paneId));
  if (ordered.length === 0 && outcomes.length === 0) return null;
  return <div className="sign-in-cards">
    {outcomes.map(({ id, outcome }) => <p key={id} className={`sign-in-outcome${outcome.result === "logged-in" || outcome.result === "already-logged-in" ? " is-ok" : ""}`} role="status">{outcomeText(t, outcome)}</p>)}
    {ordered.map((request) => <SignInCard key={request.id} request={request}
      onAnswering={(answered) => setHeld((previous) => previous.some((request) => request.id === answered.id) ? previous : [...previous, answered])}
      onOutcome={(id, outcome) => {
        setHeld((previous) => previous.filter((request) => request.id !== id));
        // one login answers several cards (passphrase, then credentials): one line for the same outcome
        setOutcomes((previous) => previous.some((entry) => outcomeText(t, entry.outcome) === outcomeText(t, outcome)) ? previous : [...previous, { id, outcome }]);
      }} />)}
  </div>;
}
