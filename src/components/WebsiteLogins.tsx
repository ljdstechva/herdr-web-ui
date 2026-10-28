import { useCallback, useEffect, useState } from "react";
import { KeyRound, LockKeyhole, Plus, RefreshCw } from "lucide-react";
import type { SignInSites } from "../../shared/sign-in.ts";
import { changeSignInSite, fetchSignInSites, unlockSignIn } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { SettingsGroup } from "./SettingsControls.tsx";
import "./WebsiteLogins.css";

/** a site name as the broker spells them (server/sign-in.ts has the same rule) */
const SITE = /^[a-z0-9][a-z0-9._-]{0,40}$/;

/**
 * Settings → Website logins: the sites this PC's sign-in broker holds a login for, by name and
 * username only. Changing one, or adding one, asks the broker for a card: it comes up under the
 * message box of the chat, where the owner types the new login; this page closes to show it.
 * No password is ever read here.
 */
export function WebsiteLoginsPage({ onClose }: { onClose: () => void }) {
  const t = useT();
  const machineId = useMachineId();
  const [sites, setSites] = useState<SignInSites | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setError(null);
    fetchSignInSites().then(setSites, (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);
  useEffect(() => { load(); }, [load]);
  const ask = (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null);
    // the card the broker puts up is drawn over the message box: close this to show it
    work().then(onClose, (reason: unknown) => { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false); });
  };
  const note = t("The logins agents use for websites, kept in an encrypted vault on the PC this app runs on. To change one, tap it: a card under the message box of the chat takes the new login, and no agent sees it.");
  if (machineId !== "local") return <SettingsGroup note={note}><p className="settings-item settings-hint" role="status">{t("Open this page for the PC the app runs on.")}</p></SettingsGroup>;
  if (sites === null && error === null) return <SettingsGroup note={note}><p className="settings-item settings-hint" role="status">{t("Loading…")}</p></SettingsGroup>;
  const retry = <button type="button" className="btn btn-ghost" onClick={load}><RefreshCw aria-hidden="true" /> {t("Try again")}</button>;
  if (sites === null) return <SettingsGroup note={note}><p className="settings-item settings-hint" role="alert">{error}</p><div className="settings-item website-logins-actions">{retry}</div></SettingsGroup>;
  if (sites.broker === "offline") return <SettingsGroup note={note}><p className="settings-item settings-hint" role="status">{t("The sign-in broker on this PC is not running.")}</p><div className="settings-item website-logins-actions">{retry}</div></SettingsGroup>;
  const add = <form className="settings-item website-logins-add" onSubmit={(event) => { event.preventDefault(); const site = name.trim().toLowerCase(); if (!SITE.test(site)) { setError(t("A site name is letters, digits, dots and dashes, like canva or trello.")); return; } ask(() => changeSignInSite(site)); }}>
    <label className="website-logins-add-label">{t("Site name")}
      <input className="input" type="text" value={name} autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={41} placeholder="canva" disabled={busy} onChange={(event) => setName(event.target.value)} list="website-logins-known" />
    </label>
    {sites.known.length > 0 && <datalist id="website-logins-known">{sites.known.map((known) => <option key={known} value={known} />)}</datalist>}
    <button type="submit" className="btn" disabled={busy || name.trim() === ""}><Plus aria-hidden="true" /> {t("Add a site")}</button>
  </form>;
  if (!sites.vault || sites.locked) return <SettingsGroup note={note}>
    <p className="settings-item settings-hint" role="status">{sites.vault ? t("The vault is locked since the PC restarted. Unlock it to see the sites.") : t("No vault yet. Create one with a passphrase; agents never see it.")}</p>
    <div className="settings-item website-logins-actions">
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => ask(unlockSignIn)}><LockKeyhole aria-hidden="true" /> {sites.vault ? t("Unlock") : t("Create vault")}</button>
    </div>
    {error !== null && <p className="settings-item settings-hint" role="alert">{error}</p>}
  </SettingsGroup>;
  const list = sites.sites ?? [];
  return <SettingsGroup note={note}>
    {list.length === 0 && <p className="settings-item settings-hint" role="status">{t("No logins saved yet.")}</p>}
    {list.map((site) => <div key={site.site} className="settings-item website-logins-row">
      <div className="website-logins-text">
        <span className="website-logins-name"><KeyRound size={14} aria-hidden="true" /> {site.site}</span>
        <span className="website-logins-user">{site.username}{site.login_url !== null ? ` · ${site.login_url}` : ""}</span>
      </div>
      <button type="button" className="btn" disabled={busy} onClick={() => ask(() => changeSignInSite(site.site))}>{t("Change login")}</button>
    </div>)}
    {add}
    {error !== null && <p className="settings-item settings-hint" role="alert">{error}</p>}
  </SettingsGroup>;
}
