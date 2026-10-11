import { expect, it } from "bun:test";
import { Outbox, SENT_LINGER_MS, countSent, sentBaseline, transcriptHolds, type Delivery } from "./outbox.ts";

function fixture() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const timers: Array<{ run: () => void; ms: number }> = [];
  return { data, timers, store: new Outbox(() => storage, (run, ms) => { timers.push({ run, ms }); }) };
}
/** A delivery the test answers when it chooses. */
function held() {
  const calls: string[] = [];
  const answers: Array<(answer: Delivery<string>) => void> = [];
  const deliver = (text: string): Promise<Delivery<string>> => { calls.push(text); return new Promise((resolve) => { answers.push(resolve); }); };
  return { calls, answers, deliver };
}
const settled = (): Promise<void> => new Promise((done) => setTimeout(done, 0));
const view = (store: Outbox, owner: string) => store.read(owner).map((message) => `${message.text}:${message.state}`);

it("shows a message as sending at once and as sent once the pane has it", async () => {
  const { store, timers } = fixture();
  const pane = held();
  const refused: string[][] = [];
  let delivered = 0;
  store.send("a", "hello", { deliver: pane.deliver, refused: (texts) => refused.push(texts), delivered: () => { delivered += 1; } });
  expect(view(store, "a")).toEqual(["hello:sending"]);
  expect(store.busy("a")).toBe(true);
  await settled();
  expect(pane.calls).toEqual(["hello"]);
  pane.answers[0]!({ ok: true });
  await settled();
  expect(view(store, "a")).toEqual(["hello:sent"]);
  expect(store.busy("a")).toBe(false);
  expect(delivered).toBe(1);
  expect(refused).toEqual([]);
  // a command that logs no turn does not stay in the chat for good
  expect(timers.map((timer) => timer.ms)).toEqual([SENT_LINGER_MS]);
  timers[0]!.run();
  expect(view(store, "a")).toEqual([]);
});

it("keeps one pane's sends in order, one at a time, apart from another pane's", async () => {
  const { store } = fixture();
  const pane = held();
  const hooks = { deliver: pane.deliver, refused: () => {} };
  store.send("a", "first", hooks);
  store.send("a", "second", hooks);
  store.send("b", "elsewhere", hooks);
  await settled();
  expect(pane.calls).toEqual(["first", "elsewhere"]);
  expect(view(store, "a")).toEqual(["first:sending", "second:sending"]);
  pane.answers[0]!({ ok: true });
  await settled();
  expect(pane.calls).toEqual(["first", "elsewhere", "second"]);
  expect(view(store, "a")).toEqual(["first:sent", "second:sending"]);
});

it("returns a refused message with those waiting behind it, and sends none of them", async () => {
  const { store } = fixture();
  const pane = held();
  const refused: Array<{ texts: string[]; refusal: string | null }> = [];
  const hooks = { deliver: pane.deliver, refused: (texts: string[], refusal: string | null) => refused.push({ texts, refusal }) };
  store.send("a", "first", hooks);
  store.send("a", "second", hooks);
  store.send("a", "third", hooks);
  await settled();
  pane.answers[0]!({ ok: false, refusal: "agent_blocked" });
  await settled();
  expect(refused).toEqual([{ texts: ["first", "second", "third"], refusal: "agent_blocked" }]);
  expect(pane.calls).toEqual(["first"]);
  expect(view(store, "a")).toEqual([]);
  expect(store.busy("a")).toBe(false);
  // the pane takes messages again afterwards
  store.send("a", "again", hooks);
  await settled();
  expect(pane.calls).toEqual(["first", "again"]);
});

it("treats a delivery that throws as not confirmed, and leaves an earlier sent message alone", async () => {
  const { store } = fixture();
  const refused: Array<{ texts: string[]; refusal: string | null }> = [];
  const hooks = (deliver: () => Delivery<string>) => ({ deliver, refused: (texts: string[], refusal: string | null) => refused.push({ texts, refusal }) });
  store.send("a", "went", hooks(() => ({ ok: true })));
  store.send("a", "broke", hooks(() => { throw new Error("socket closed"); }));
  await settled();
  expect(refused).toEqual([{ texts: ["broke"], refusal: null }]);
  expect(view(store, "a")).toEqual(["went:sent"]);
});

it("hands a queued message to the bridge's own list instead of the chat", async () => {
  const { store, timers } = fixture();
  store.send<string>("a", "next turn", { deliver: () => ({ ok: true, queued: true }), refused: () => {} });
  await settled();
  expect(view(store, "a")).toEqual([]);
  expect(timers).toEqual([]);
});

it("drops a message the transcript already holds, whichever comes first: the turn or the answer", async () => {
  const { store } = fixture();
  const pane = held();
  const hooks = { deliver: pane.deliver, refused: () => {} };
  const early = store.send("a", "seen first", hooks);
  await settled();
  store.markSeen("a", early);
  expect(store.read("a")).toEqual([{ id: early, text: "seen first", state: "sending", seen: true }]);
  // still on its way: nothing else of this pane leaves before its answer
  expect(store.busy("a")).toBe(true);
  pane.answers[0]!({ ok: true });
  await settled();
  expect(view(store, "a")).toEqual([]);

  const late = store.send("a", "answered first", hooks);
  await settled();
  pane.answers[1]!({ ok: true });
  await settled();
  expect(view(store, "a")).toEqual(["answered first:sent"]);
  store.markSeen("a", late);
  expect(view(store, "a")).toEqual([]);
});

it("keeps only unanswered messages for a reload, and offers them back once", async () => {
  const { store, data } = fixture();
  const pane = held();
  const hooks = { deliver: pane.deliver, refused: () => {} };
  store.send("a", "answered", hooks);
  store.send("a", "cut off", hooks);
  await settled();
  expect(JSON.parse(data.get("herdr-web-ui:outbox:a")!)).toEqual(["answered", "cut off"]);
  pane.answers[0]!({ ok: true });
  await settled();
  expect(JSON.parse(data.get("herdr-web-ui:outbox:a")!)).toEqual(["cut off"]);
  // this page's own sends are not abandoned
  expect(store.takeAbandoned("a")).toEqual([]);

  // the page reloads: a new store over the same tab storage
  const reloaded = new Outbox(() => ({ getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } }));
  expect(reloaded.read("a")).toEqual([]);
  expect(reloaded.takeAbandoned("a")).toEqual(["cut off"]);
  expect(reloaded.takeAbandoned("a")).toEqual([]);
  expect(data.has("herdr-web-ui:outbox:a")).toBe(false);
});

it("sends and shows messages when tab storage is blocked", async () => {
  const store = new Outbox(() => { throw new Error("blocked"); }, () => {});
  store.send<string>("a", "still goes", { deliver: () => ({ ok: true }), refused: () => {} });
  expect(view(store, "a")).toEqual(["still goes:sending"]);
  await settled();
  expect(view(store, "a")).toEqual(["still goes:sent"]);
  expect(store.takeAbandoned("b")).toEqual([]);
});

it("hands readers the same list until a message changes", async () => {
  const { store } = fixture();
  let updates = 0;
  const off = store.subscribe(() => { updates += 1; });
  expect(store.read("a")).toBe(store.read("a"));
  store.send<string>("a", "one", { deliver: () => ({ ok: true }), refused: () => {} });
  const first = store.read("a");
  expect(store.read("a")).toBe(first);
  await settled();
  expect(store.read("a")).not.toBe(first);
  expect(updates).toBeGreaterThanOrEqual(2);
  off();
});

it("counts a message as in the transcript only past the copies it held when it was sent", () => {
  const transcript = ["yes", "run the tests", "  yes\n"];
  expect(countSent(transcript, "yes")).toBe(2);
  const outgoing = [
    { id: "1", text: "yes", state: "sending" as const, seen: false },
    { id: "2", text: "yes", state: "sending" as const, seen: false },
    { id: "3", text: "something else", state: "sending" as const, seen: false },
  ];
  // the first needs a third "yes"; the second, behind it, a fourth
  const [first, second, third] = outgoing.map((_, index) => sentBaseline(outgoing, index, transcript));
  expect(first).toEqual({ same: 2, total: 3 });
  expect(second).toEqual({ same: 3, total: 4 });
  expect(third).toEqual({ same: 0, total: 5 });
  expect(transcriptHolds(outgoing[0]!, first!, transcript)).toBe(false);
  expect(transcriptHolds(outgoing[0]!, first!, [...transcript, "yes"])).toBe(true);
  expect(transcriptHolds(outgoing[1]!, second!, [...transcript, "yes"])).toBe(false);
  expect(transcriptHolds(outgoing[1]!, second!, [...transcript, "yes", "yes"])).toBe(true);
  // one the transcript already took is not waited behind
  expect(sentBaseline([{ ...outgoing[0]!, seen: true }, outgoing[1]!], 1, [...transcript, "yes"])).toEqual({ same: 3, total: 4 });
});

it("takes a new user message in other words for a message the pane already answered for, never for one still sending", () => {
  const transcript = ["earlier"];
  const sending = { id: "1", text: "/review the diff", state: "sending" as const, seen: false };
  const baseline = sentBaseline([sending], 0, transcript);
  const logged = [...transcript, "Review the diff: (the command's own prompt)"];
  expect(transcriptHolds(sending, baseline, logged)).toBe(false);
  expect(transcriptHolds({ ...sending, state: "sent" }, baseline, logged)).toBe(true);
  expect(transcriptHolds({ ...sending, state: "sent" }, baseline, transcript)).toBe(false);
});
