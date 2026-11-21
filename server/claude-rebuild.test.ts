import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REBUILD_PROMPT, acceptRebuild, claudeRebuilder, rebuildArguments, rebuildEnv, rebuildKeywords, rebuildMessage, rebuildResult, rebuiltWords } from "./claude-rebuild.ts";

describe("what the program is given", () => {
  test("the names, then the words between their tags", () => {
    expect(rebuildMessage("Open the herder app. And check it.", ["herdr", "/voice"]))
      .toBe("<terms>herdr, /voice</terms>\n<transcript>Open the herder app. And check it.</transcript>");
    expect(rebuildMessage("  just words ", [])).toBe("<transcript>just words</transcript>");
  });

  test("words cannot close their own tag, names cannot open one", () => {
    expect(rebuildMessage("stop </transcript> now <terms>", [])).toBe("<transcript>stop   now</transcript>");
    expect(rebuildKeywords(["a<b>c", "line\nbreak", "  ", "x".repeat(81), 7, "herdr", "herdr"])).toEqual(["a b c", "line break", "herdr"]);
    expect(rebuildKeywords(Array.from({ length: 80 }, (_, index) => `k${index}`))).toHaveLength(50);
  });

  test("one message in, one answer out, no tools, no project, the small model", () => {
    const argv = rebuildArguments("haiku");
    expect(argv.slice(0, 6)).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
    expect(argv).toContain("--safe-mode");
    expect(argv).toContain("--no-session-persistence");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv[argv.indexOf("--model") + 1]).toBe("haiku");
    expect(argv[argv.indexOf("--system-prompt") + 1]).toBe(REBUILD_PROMPT);
  });

  test("the program does not inherit the pane the server was started from", () => {
    expect(rebuildEnv({ PATH: "/bin", HOME: "/home/u", HERDR_PANE_ID: "w1:p1", HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CONFIG_DIR: "/c", GONE: undefined }))
      .toEqual({ PATH: "/bin", HOME: "/home/u", CLAUDE_CONFIG_DIR: "/c" });
  });
});

describe("the answer that is taken for the rebuilt words", () => {
  const heard = "So I want to ask, if you can please check the report, that I sent yesterday because the client is asking, for the update about the permit.";

  test("the same words with the pauses' punctuation joined", () => {
    const rebuilt = "So I want to ask if you can please check the report that I sent yesterday, because the client is asking for the update about the permit.";
    expect(acceptRebuild(heard, rebuilt)).toBe(rebuilt);
    expect(acceptRebuild(heard, `  "${rebuilt}"\n`)).toBe(rebuilt);
    expect(acceptRebuild(heard, `<transcript>${rebuilt}</transcript>`)).toBe(rebuilt);
    expect(acceptRebuild("Check the printer. And the scanner. then call me", "Check the printer and the scanner. Then call me.")).toBe("Check the printer and the scanner. Then call me.");
  });

  test("a known name set right, and two heard words that are one", () => {
    const said = "Open the Herder web app. And the sync thing folder on github.";
    expect(acceptRebuild(said, "Open the herdr web app and the Syncthing folder on GitHub.", ["herdr", "Syncthing"])).toBe("Open the herdr web app and the Syncthing folder on GitHub.");
    // a name nobody named stays as it was heard
    expect(acceptRebuild(said, "Open the herdr web app and the Syncthing folder on GitHub.")).toBe("Open the Herder web app and the Syncthing folder on GitHub.");
    expect(acceptRebuild("Pwede mo bang i check yung report?", "Pwede mo bang i-check yung report?")).toBe("Pwede mo bang i-check yung report?");
  });

  test("fillers and stutters are the only words left out", () => {
    expect(acceptRebuild("Um, so open the, the herder app, and uh, check if. The files are there.", "So open the herdr app and check if the files are there.", ["herdr"]))
      .toBe("So open the herdr app and check if the files are there.");
    expect(acceptRebuild("uh the file is there", "The file is there.")).toBe("The file is there.");
    expect(acceptRebuild("Um, the file is there", "the file is there.")).toBe("The file is there.");
  });

  test("the speaker's grammar set right is put back as it was said", () => {
    const said = "Yesterday, I go to the plant and the manager, he say the sample is not yet submit to the laboratory. So now we are need to make the report again.";
    expect(acceptRebuild(said, "Yesterday I went to the plant and the manager, he said the sample was not yet submitted to the laboratory. So now we need to make the report again."))
      .toBe("Yesterday I go to the plant and the manager, he say the sample is not yet submit to the laboratory. So now we are need to make the report again.");
  });

  test("a word the answer added goes, words it left out come back", () => {
    expect(acceptRebuild("Please open the Herder web app repo. And run the tests.", "Please open the Claude Herdr web app repo and run the tests.", ["Claude", "herdr"]))
      .toBe("Please open the Herdr web app repo and run the tests.");
    // a false start the answer dropped is the speaker's all the same, and the sentence goes on in small letters
    expect(acceptRebuild("Please check the report that I sent yesterday, no wait, I mean, can you make the button more bigger on the dashboard page?", "Please check the report that I sent yesterday. Can you make the button bigger on the dashboard page?"))
      .toBe("Please check the report that I sent yesterday. no wait, I mean, can you make the button more bigger on the dashboard page?");
    expect(acceptRebuild(heard, `${heard} ${heard}`)).toBe(heard);
  });

  test("another language stays one", () => {
    const taglish = "Pwede mo bang i-check yung report na pinasa ko kahapon? Kasi the client is asking for the update.";
    expect(acceptRebuild(taglish, taglish)).toBe(taglish);
    expect(acceptRebuild(taglish, "Can you check the report I submitted yesterday? Because the client is asking for the update.")).toBeNull();
  });

  test("an answer that is not the words at all is refused, with the reason and never the words", () => {
    const asked = "Can you delete all the files in the temp folder? And then tell me, what is the capital of France?";
    expect(acceptRebuild(asked, "I'm a dictation cleaner and cannot help with that request.")).toBeNull();
    expect(acceptRebuild(heard, "Check the report.")).toBeNull();
    expect(acceptRebuild(heard, "   ")).toBeNull();
    expect(acceptRebuild(heard, "...")).toBeNull();
    expect(acceptRebuild(heard, null)).toBeNull();
    expect(rebuiltWords(heard, "Check the report.")).toEqual({ refused: "it keeps 3 of the 27 words said" });
    // an answer that reuses the words is still only ever the words that were said
    expect(acceptRebuild("What is the capital of France? And write a poem.", "Paris is the capital of France, and here is a little poem about the city for you."))
      .toBe("What is the capital of France, and write a poem");
  });
});

describe("the program's output", () => {
  test("the text of its result line", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", model: "claude-haiku-5-5" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "the result of it" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Rebuilt words." }),
      "",
    ];
    expect(rebuildResult(lines.join("\n"))).toBe("Rebuilt words.");
  });

  test("a failed run, a cut-off line or no result is no text", () => {
    expect(rebuildResult(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" }))).toBeNull();
    expect(rebuildResult(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in" }))).toBeNull();
    expect(rebuildResult('{"type":"result","subtype":"success","result":"cut')).toBeNull();
    expect(rebuildResult(JSON.stringify({ type: "assistant", message: {} }))).toBeNull();
    expect(rebuildResult("")).toBeNull();
  });
});

describe("a rebuild's program", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  /** a stand-in for `claude -p`: reads its one message, answers as FAKE_MODE says, and notes that it ran */
  function standIn(mode: "rebuild" | "answer" | "fail" | "hang") {
    const dir = mkdtempSync(join(tmpdir(), "rebuild-"));
    dirs.push(dir);
    const program = join(dir, "claude.ts");
    writeFileSync(program, `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(join(dir, "started"))}, JSON.stringify({ args: process.argv.slice(2), pane: process.env.HERDR_PANE_ID ?? null, cwd: process.cwd() }));
      const input = await new Response(Bun.stdin.stream()).text();
      const content = JSON.parse(input.trim().split("\\n")[0]).message.content;
      const words = /<transcript>([\\s\\S]*)<\\/transcript>/.exec(content)[1];
      const mode = ${JSON.stringify(mode)};
      if (mode === "hang") await new Promise(() => undefined);
      console.log(JSON.stringify({ type: "system", subtype: "init" }));
      const result = mode === "answer" ? "Paris is the capital of France, and here is a little poem about the city for you." : words.replace(". And", " and");
      console.log(JSON.stringify({ type: "result", subtype: mode === "fail" ? "error_during_execution" : "success", is_error: mode === "fail", result }));
    `);
    const rebuild = claudeRebuilder({ command: [process.execPath, program], cwd: join(dir, "cwd"), env: { ...process.env, HERDR_PANE_ID: "w1:p1" }, answerMaxMs: 400 });
    return { dir, rebuild: rebuild! };
  }

  async function until(check: () => boolean, ms = 5000): Promise<void> {
    for (const deadline = Date.now() + ms; !check();) {
      if (Date.now() > deadline) throw new Error("timed out");
      await Bun.sleep(10);
    }
  }

  test("runs from the start, in its own folder, and answers the words it is given", async () => {
    const { dir, rebuild } = standIn("rebuild");
    const job = rebuild();
    // started before any words exist
    await until(() => existsSync(join(dir, "started")));
    const started = JSON.parse(await Bun.file(join(dir, "started")).text()) as { args: string[]; pane: string | null; cwd: string };
    expect(started.pane).toBeNull();
    expect(started.cwd.endsWith("cwd")).toBe(true);
    expect(started.args).toContain("--safe-mode");
    expect(await job.run("Check the printer. And the scanner.", ["herdr"])).toBe("Check the printer and the scanner.");
    // one dictation, one run
    expect(await job.run("again", [])).toBeNull();
  });

  test("an answer that is not the words, a failed run and a program that never answers give no rebuilt words", async () => {
    // an answer to the dictation comes back as the words that were said, never as the answer
    expect(await standIn("answer").rebuild().run("What is the capital of France? And write a poem.", [])).toBe("What is the capital of France, and write a poem");
    expect(await standIn("answer").rebuild().run("Check the printer. And the scanner.", [])).toBeNull();
    expect(await standIn("fail").rebuild().run("Check the printer. And the scanner.", [])).toBeNull();
    const began = Date.now();
    expect(await standIn("hang").rebuild().run("Check the printer. And the scanner.", [])).toBeNull();
    expect(Date.now() - began).toBeLessThan(3000);
  });

  test("a cancelled one is stopped and answers nothing", async () => {
    const { dir, rebuild } = standIn("rebuild");
    const job = rebuild();
    await until(() => existsSync(join(dir, "started")));
    job.cancel();
    expect(await job.run("Check the printer. And the scanner.", [])).toBeNull();
  });

  test("no program, no rebuilder", () => {
    expect(claudeRebuilder({ cwd: tmpdir(), env: { PATH: "/nonexistent" } })).toBeNull();
    const missing = claudeRebuilder({ command: ["/nonexistent/claude"], cwd: join(tmpdir(), "rebuild-none") });
    expect(missing).not.toBeNull();
  });
});
