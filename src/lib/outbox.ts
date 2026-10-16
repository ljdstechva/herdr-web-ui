/**
 * Messages on their way. Send clears the box and puts the message in the chat at once, marked
 * "Sending…"; the bridge's answer turns that into "Sent", and the transcript's own turn then
 * takes its place. Nothing here is ever sent again by itself: a message the bridge refuses, or
 * one whose answer never came, goes back to the box it left, in the order it was typed.
 *
 * Sends of one pane go one at a time, in order. A second message sent while the first is still
 * on its way waits for that answer, on this page only: it is shown as sending, and a refusal of
 * the one before it returns both.
 */
import { sameMessage } from "./compose.ts";

export interface OutgoingMessage {
  id: string;
  text: string;
  state: "sending" | "sent";
  /** the transcript already holds it: no longer drawn, and dropped once its answer is in */
  seen: boolean;
}

/** What a delivery answers: sent, taken into the bridge's own waiting list, or refused with whatever the caller says of it. */
export type Delivery<Refusal> = { ok: true; queued?: boolean } | { ok: false; refusal: Refusal };

export interface SendHooks<Refusal> {
  /** Sends the message now: called when its turn comes, never twice. */
  deliver: (text: string) => Delivery<Refusal> | Promise<Delivery<Refusal>>;
  /** Not sent: this message and those typed after it that had not left yet, in order. */
  refused: (texts: string[], refusal: Refusal | null) => void;
  /** Its answer is in: it is in the pane, or in the bridge's waiting list. */
  delivered?: () => void;
}

/** How long a sent message stays in the chat without the transcript showing it (a command that logs no turn). */
export const SENT_LINGER_MS = 8_000;
const STORAGE_PREFIX = "herdr-web-ui:outbox:";
const NONE: readonly OutgoingMessage[] = Object.freeze([]);

type TabStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
interface Entry extends OutgoingMessage { started: boolean }

export class Outbox {
  private rows = new Map<string, Entry[]>();
  private views = new Map<string, readonly OutgoingMessage[]>();
  private chains = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  private sequence = 0;
  constructor(
    /** per tab, and it outlives a reload: what was on its way when the page went is offered back */
    private storage: () => TabStorage = () => window.sessionStorage,
    private schedule: (run: () => void, ms: number) => unknown = (run, ms) => setTimeout(run, ms),
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** The pane's messages on their way, oldest first; the same array until one changes. */
  read(owner: string): readonly OutgoingMessage[] {
    return this.views.get(owner) ?? NONE;
  }

  /** Is a message of this pane still waiting for its answer? */
  busy(owner: string): boolean {
    return this.rows.get(owner)?.some((entry) => entry.state === "sending") === true;
  }

  private publish(owner: string, next: Entry[]): void {
    if (next.length === 0) { this.rows.delete(owner); this.views.delete(owner); }
    else {
      this.rows.set(owner, next);
      this.views.set(owner, next.map(({ id, text, state, seen }) => ({ id, text, state, seen })));
    }
    // only what has no answer yet is kept for a reload: a sent message is the transcript's
    const unanswered = next.filter((entry) => entry.state === "sending").map((entry) => entry.text);
    try {
      if (unanswered.length === 0) this.storage().removeItem(STORAGE_PREFIX + owner);
      else this.storage().setItem(STORAGE_PREFIX + owner, JSON.stringify(unanswered));
    } catch { /* without storage a reload mid-send loses the copy, as the send itself still goes */ }
    for (const listener of this.listeners) listener();
  }

  private update(owner: string, id: string, change: (entry: Entry) => Entry | null): void {
    const rows = this.rows.get(owner);
    if (!rows?.some((entry) => entry.id === id)) return;
    this.publish(owner, rows.flatMap((entry) => {
      if (entry.id !== id) return [entry];
      const next = change(entry);
      return next === null ? [] : [next];
    }));
  }

  /**
   * What a page that went away mid-send left unanswered, once: the caller puts it back in the
   * box. Whether the pane took it is not known, and it is not sent again from here.
   */
  takeAbandoned(owner: string): string[] {
    // this page's own sends are not abandoned
    if (this.rows.has(owner)) return [];
    try {
      const raw = this.storage().getItem(STORAGE_PREFIX + owner);
      if (raw === null) return [];
      this.storage().removeItem(STORAGE_PREFIX + owner);
      const texts: unknown = JSON.parse(raw);
      return Array.isArray(texts) ? texts.filter((text): text is string => typeof text === "string" && text.length > 0) : [];
    } catch {
      return [];
    }
  }

  /** Shows the message as sending now, and delivers it once the pane's earlier sends have their answers. */
  send<Refusal>(owner: string, text: string, hooks: SendHooks<Refusal>): string {
    const id = `out-${Date.now().toString(36)}-${++this.sequence}`;
    this.publish(owner, [...(this.rows.get(owner) ?? []), { id, text, state: "sending", seen: false, started: false }]);
    const run = (this.chains.get(owner) ?? Promise.resolve()).then(async () => {
      // a refusal before it took it back to the box already
      if (!this.rows.get(owner)?.some((entry) => entry.id === id)) return;
      this.update(owner, id, (entry) => ({ ...entry, started: true }));
      let answer: Delivery<Refusal> | null = null;
      try { answer = await hooks.deliver(text); } catch { answer = null; }
      if (answer?.ok) {
        const queued = answer.queued === true;
        // in the bridge's waiting list it has a row of its own; seen already, the transcript's turn stands for it
        this.update(owner, id, (entry) => queued || entry.seen ? null : { ...entry, state: "sent" });
        if (!queued) this.schedule(() => this.update(owner, id, () => null), SENT_LINGER_MS);
        hooks.delivered?.();
        return;
      }
      // with it go the messages typed after it that had not left: they were written to follow it
      const rows = this.rows.get(owner) ?? [];
      const returned = rows.filter((entry) => entry.id === id || (entry.state === "sending" && !entry.started));
      this.publish(owner, rows.filter((entry) => !returned.includes(entry)));
      hooks.refused(returned.map((entry) => entry.text), answer === null ? null : answer.refusal);
    });
    this.chains.set(owner, run);
    void run.finally(() => { if (this.chains.get(owner) === run) this.chains.delete(owner); });
    return id;
  }

  /** The transcript holds this message: its own turn is drawn, not this copy. */
  markSeen(owner: string, id: string): void {
    this.update(owner, id, (entry) => entry.state === "sent" ? null : entry.seen ? entry : { ...entry, seen: true });
  }
}

export const outbox = new Outbox();

/** How many of the transcript's user messages are this text. */
export function countSent(userTexts: readonly string[], text: string): number {
  let count = 0;
  for (const user of userTexts) if (sameMessage(user, text)) count += 1;
  return count;
}

/** What the transcript has to pass before it is said to hold a message on its way. */
export interface SentBaseline {
  /** its user messages with this text when the message was sent, and one for each of the same text still on its way before it */
  same: number;
  /** all its user messages then, and one for each message still on its way before it */
  total: number;
}

/**
 * Counted once, with the transcript as it stood when the message appeared: each message on its
 * way before this one takes a turn of its own first.
 */
export function sentBaseline(outgoing: readonly OutgoingMessage[], index: number, userTexts: readonly string[]): SentBaseline {
  const message = outgoing[index]!;
  const ahead = outgoing.slice(0, index).filter((earlier) => !earlier.seen);
  return {
    same: countSent(userTexts, message.text) + ahead.filter((earlier) => sameMessage(earlier.text, message.text)).length,
    total: userTexts.length + ahead.length,
  };
}

/**
 * Does the transcript hold this message now? One more message of its text than before says so
 * at any time. An agent may also log it in other words than it was typed in (a command it
 * expands, a file it names its own way): once the pane has answered for the message, a new user
 * message of any text is taken for it, so the two are not shown one under the other.
 */
export function transcriptHolds(message: OutgoingMessage, baseline: SentBaseline, userTexts: readonly string[]): boolean {
  if (countSent(userTexts, message.text) > baseline.same) return true;
  return message.state === "sent" && userTexts.length > baseline.total;
}
