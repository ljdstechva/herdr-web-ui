import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationTurn } from "../shared/protocol.ts";
import { forgetTranscriptState, parseClaudeTranscript, transcriptPage } from "./conversation.ts";

// Shapes after upstream's claude-incremental tests (#3658, #3667); every value is made up.
const jsonl = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
const user = (content: unknown) => ({ type: "user", message: { role: "user", content } });
const assistant = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" } });
const notification = (id: string, use: string, result: string, summary = 'Agent "Price the path" finished') =>
  `<task-notification><task-id>${id}</task-id><tool-use-id>${use}</tool-use-id><status>completed</status><summary>${summary}</summary><result>${result}</result></task-notification>`;
const enqueue = (content: string) => ({ type: "queue-operation", operation: "enqueue", content });
const queuedNotice = (prompt: string) => ({ type: "attachment", attachment: { type: "queued_command", commandMode: "task-notification", prompt } });
const tasks = (turns: ConversationTurn[]) => turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "task_result" ? part.tasks : []));
const notices = (turns: ConversationTurn[]) => turns.flatMap((turn) => turn.parts.filter((part) => part.kind === "notice"));
const rows = (turns: ConversationTurn[]) => turns.map((turn) => turn.parts.map((part) => part.kind === "text" ? part.text
  : part.kind === "task_result" ? `card:${part.tasks[0]!.result.slice(0, 10)}` : part.kind).join(" "));

/**
 * Claude Code 2.1.30x: a background subagent sends its report with SubagentHandback, as another
 * session's message framed and indented; the task's notification then only points at it. 2.1.31x
 * adds `handback: true` and the report itself (`handbackReportText`) to the same origin.
 */
function handbackRecords(lines = ["## Verdict", "", "**No.** The path is not cheaper.", "  - indented item"], { reportText = false, queued = false } = {}) {
  const frame = "[Subagent hand-back] The text below is the final report of a subagent this session delegated to. The report follows:";
  const body = `${frame}\n${lines.map((line) => `  ${line}`).join("\n")}`;
  const origin = { kind: "peer", from: "a3e6", senderTaskId: "a3e6", name: "general-purpose", body,
    ...(reportText ? { handback: true, handbackReportText: lines.join("\n"), handbackToolUseId: "toolu_back" } : {}) };
  const prompt = `<agent-message from="a3e6">\n${body}\n</agent-message>`;
  const handback = queued
    ? { type: "attachment", attachment: { type: "queued_command", commandMode: "prompt", prompt, origin, isMeta: true } }
    : { ...user(`Another Claude session sent a message:\n${prompt}`), isMeta: true, origin };
  const pointer = 'This agent\'s report was delivered to you as a message from "a3e6" (its SubagentHandback call). Read it there; it is not repeated here.\n';
  const ended = notification("a3e6", "toolu_a3e6", pointer);
  return { handback, origin, pointer, ended, report: lines.join("\n").trim() };
}

describe("a subagent's hand-back report in its task card", () => {
  it("puts the report in the card, whichever of the two arrives first", () => {
    const { handback, ended, report } = handbackRecords();
    for (const records of [[enqueue(ended), handback, user(ended)], [handback, user(ended)], [handback, enqueue(ended), assistant("Noted."), queuedNotice(ended)]]) {
      const turns = parseClaudeTranscript(jsonl(user("Price it"), assistant("Started."), ...records));
      expect(notices(turns)).toEqual([]);
      expect(tasks(turns).map(({ id, title, result }) => ({ id, title, result }))).toEqual([{ id: "a3e6", title: "Price the path", result: report }]);
    }
  });

  it("reads the report Claude Code records beside the frame, as a meta entry and as a queued attachment", () => {
    for (const queued of [false, true]) {
      const { handback, ended, report } = handbackRecords(undefined, { reportText: true, queued });
      for (const records of [[enqueue(ended), handback, queuedNotice(ended)], [handback, enqueue(ended), queuedNotice(ended)]]) {
        const turns = parseClaudeTranscript(jsonl(user("Price it"), assistant("Started."), ...records));
        expect(notices(turns)).toEqual([]);
        expect(tasks(turns).map((task) => task.result)).toEqual([report]);
      }
    }
  });

  it("draws one card for a report recorded twice, queued and then echoed", () => {
    const echo = handbackRecords(undefined, { reportText: true }).handback;
    const { handback, ended, report } = handbackRecords(undefined, { reportText: true, queued: true });
    const turns = parseClaudeTranscript(jsonl(user("Price it"), assistant("Started."), handback, enqueue(ended), echo, queuedNotice(ended)));
    expect(notices(turns)).toEqual([]);
    expect(tasks(turns).map((task) => task.result)).toEqual([report]);
  });

  it("keeps another session's message as its own notice, and a pointer whose report never came as written", () => {
    const { origin, pointer } = handbackRecords();
    const other = pointer.replace("a3e6", "b1");
    const message = { ...user("Another Claude session sent a message"), isMeta: true, origin: { ...origin, senderTaskId: undefined, from: "other" } };
    const turns = parseClaudeTranscript(jsonl(message, user(notification("b1", "toolu_b1", other))));
    expect(notices(turns)).toHaveLength(1);
    expect(tasks(turns).map((task) => task.result)).toEqual([other.trim()]);
  });

  it("keeps the first line's own indentation, a report that opens with code", () => {
    const { handback, ended } = handbackRecords(["", "    const x = 1;", "", "That is the line."]);
    expect(tasks(parseClaudeTranscript(jsonl(enqueue(ended), handback, user(ended)))).map((task) => task.result)).toEqual(["    const x = 1;\n\nThat is the line."]);
  });
});

describe("a subagent's hand-back through the page reader", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); forgetTranscriptState(); });
  const file = (): string => {
    const root = mkdtempSync(join(tmpdir(), "herdr-handback-page-"));
    roots.push(root);
    return join(root, "session.jsonl");
  };
  const shown = (turns: ConversationTurn[]) => ({ notices: notices(turns).length, results: tasks(turns).map((task) => task.result) });

  for (const order of ["notification first", "hand-back first", "hand-back, reply, notification", "as Claude Code 2.1.328 writes it"] as const) {
    it(`puts the report in the card, warm as cold, with the ${order}`, () => {
      const { handback, ended, report } = handbackRecords(undefined, { reportText: order === "as Claude Code 2.1.328 writes it" });
      const records = order === "notification first" ? [enqueue(ended), handback, user(ended)]
        : order === "hand-back first" ? [handback, user(ended)]
          // the agent answers the report before the notification comes: the card stays where the report came, before that answer
          : order === "hand-back, reply, notification" ? [handback, assistant("Summary of the report"), user(ended)]
            : [handback, enqueue(ended), assistant("Summary of the report"), enqueue(ended), queuedNotice(ended)];
      const path = file();
      writeFileSync(path, `${jsonl(user("Price it"), assistant("Started."), ...records)}\n`);
      const cold = transcriptPage("claude-transcript", path).turns;
      expect(shown(cold)).toEqual({ notices: 0, results: [report] });
      if (order !== "notification first" && order !== "hand-back first") expect(rows(cold)).toEqual(["Price it", "Started.", "card:## Verdict", "Summary of the report"]);
      // the next prompt settles that turn: a warm read keeps what a cold one shows
      appendFileSync(path, `${jsonl(user("Thanks"), assistant("Sure."))}\n`);
      const warm = transcriptPage("claude-transcript", path).turns;
      forgetTranscriptState();
      expect(shown(warm)).toEqual({ notices: 0, results: [report] });
      expect(warm).toEqual(transcriptPage("claude-transcript", path).turns);
    });
  }

  const peerSays = { ...user("Review ready"), isMeta: true, origin: { kind: "peer", from: "reviewer", name: "Reviewer", body: "Review ready" } };
  for (const [order, between] of [["a prompt", () => [user("next"), assistant("On it.")]], ["another session's message", () => [peerSays]]] as const) {
    it(`pairs a hand-back with its notification only within one turn, warm as cold, with ${order} between them`, () => {
      const { handback, ended, pointer } = handbackRecords();
      const path = file();
      const head = [user("Price it"), assistant("Started.")];
      // each way round: the hand-back before the turn opener and the notification after, and the reverse
      for (const [first, second] of [[[handback], [user(ended)]], [[enqueue(ended), user(ended)], [handback]]] as const) {
        writeFileSync(path, `${jsonl(...head, ...first)}\n`);
        transcriptPage("claude-transcript", path);
        appendFileSync(path, `${jsonl(...between(), ...second, user("Thanks"), assistant("Sure."))}\n`);
        const warm = transcriptPage("claude-transcript", path).turns;
        forgetTranscriptState();
        const cold = transcriptPage("claude-transcript", path).turns;
        expect(warm).toEqual(cold);
        expect(tasks(cold).map((task) => task.result)).toEqual([pointer.trim()]);
        expect(notices(cold).filter((part) => part.kind === "notice" && part.text.startsWith("[Subagent hand-back]"))).toHaveLength(1);
        forgetTranscriptState();
      }
    });
  }

  it("leaves a report longer than a card holds as the message it came as, whole", () => {
    const lines = [...Array.from({ length: 2_000 }, (_, index) => `line ${index} of the report`), "TAIL"];
    const { handback, ended, pointer } = handbackRecords(lines);
    const path = file();
    writeFileSync(path, `${jsonl(user("Price it"), enqueue(ended), handback, user(ended))}\n`);
    const turns = transcriptPage("claude-transcript", path).turns;
    const notice = notices(turns)[0];
    expect(notice?.kind === "notice" && notice.text.endsWith("TAIL")).toBeTrue();
    expect(tasks(turns).map((task) => task.result)).toEqual([pointer.trim()]);
  });
});
