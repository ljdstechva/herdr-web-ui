import { describe, expect, it } from "bun:test";

import { browserStreamUrl, KEYBOARD_FILL, KEYSYM, keysymOf, TouchGestures, typedKeysyms, typedSince, wheelMasks, type PointerAction } from "./browserView.ts";

function touch(): { gestures: TouchGestures; actions: PointerAction[]; said(): string[] } {
  const actions: PointerAction[] = [];
  const gestures = new TouchGestures((action) => actions.push(action));
  const said = (): string[] => actions.splice(0).map((action) =>
    action.type === "scroll" ? `scroll ${action.dx},${action.dy} @${action.x},${action.y}`
      : action.type === "move" ? `move ${action.x},${action.y}` : `${action.button} ${action.type} ${action.x},${action.y}`);
  return { gestures, actions, said };
}

describe("a finger on the remote screen", () => {
  it("clicks where it tapped", () => {
    const { gestures, said } = touch();
    gestures.start(100, 200, 1, 0);
    expect(gestures.waiting).toBe(true);
    gestures.move(103, 204);
    gestures.end(80);
    expect(said()).toEqual(["move 100,200", "left down 100,200", "left up 100,200"]);
  });

  it("right-clicks when held still, and clicks nothing as it lifts", () => {
    const { gestures, said } = touch();
    gestures.start(100, 200, 1, 0);
    gestures.hold();
    expect(gestures.waiting).toBe(false);
    gestures.move(160, 260);
    gestures.end(900);
    expect(said()).toEqual(["move 100,200", "right down 100,200", "right up 100,200"]);
  });

  it("scrolls the page under the finger instead of dragging, and never right-clicks after moving", () => {
    const { gestures, said } = touch();
    gestures.start(200, 600, 1, 0);
    gestures.move(200, 560);
    expect(gestures.waiting).toBe(false);
    gestures.hold();
    expect(said()).toEqual(["move 200,600"]);
    // up by 150 in all: two notches down, the rest carried into the next stroke
    gestures.move(200, 450);
    expect(said()).toEqual(["scroll 0,2 @200,600"]);
    gestures.move(200, 380);
    expect(said()).toEqual(["scroll 0,1 @200,600"]);
    // back down past where the count stands scrolls up; sideways scrolls sideways
    gestures.move(200, 480);
    gestures.move(40, 480);
    gestures.end(700);
    expect(said()).toEqual(["scroll 0,-1 @200,600", "scroll 2,0 @200,600"]);
  });

  it("double-clicks on a second tap at the same spot", () => {
    const { gestures, said } = touch();
    gestures.start(100, 200, 1, 0);
    gestures.end(60);
    gestures.start(108, 195, 1, 200);
    expect(gestures.waiting).toBe(false);
    gestures.end(260);
    expect(said()).toEqual(["move 100,200", "left down 100,200", "left up 100,200", "move 100,200", "left down 100,200", "left up 100,200"]);
    // a third tap starts over: it is not another half of a double click
    gestures.start(100, 200, 1, 400);
    expect(gestures.waiting).toBe(true);
  });

  it("drags with the button down when the second tap moves", () => {
    const { gestures, said } = touch();
    gestures.start(100, 200, 1, 0);
    gestures.end(60);
    said();
    gestures.start(100, 200, 1, 200);
    gestures.hold();
    gestures.move(180, 200);
    gestures.move(260, 210);
    gestures.end(900);
    expect(said()).toEqual(["move 100,200", "left down 100,200", "move 180,200", "move 260,210", "left up 260,210"]);
  });

  it("treats a tap long after, or far from, the first as a tap of its own", () => {
    const { gestures, said } = touch();
    gestures.start(100, 200, 1, 0);
    gestures.end(60);
    gestures.start(100, 200, 1, 600);
    expect(gestures.waiting).toBe(true);
    gestures.end(650);
    gestures.start(300, 200, 1, 700);
    expect(gestures.waiting).toBe(true);
    gestures.move(300, 100);
    gestures.end(900);
    expect(said().filter((line) => line.startsWith("scroll"))).toEqual(["scroll 0,1 @300,200"]);
  });

  it("does nothing with two fingers, and lets a held button go when a second one lands", () => {
    const { gestures, said } = touch();
    gestures.start(100, 200, 2, 0);
    gestures.move(100, 100);
    gestures.hold();
    gestures.end(300);
    expect(said()).toEqual([]);
    gestures.start(100, 200, 1, 1000);
    gestures.end(1050);
    gestures.start(100, 200, 1, 1150);
    gestures.move(200, 200);
    said();
    gestures.start(200, 200, 2, 1300);
    expect(said()).toEqual(["left up 200,200"]);
  });

  it("clicks nothing when the phone takes the touch away", () => {
    const { gestures, said } = touch();
    gestures.start(100, 200, 1, 0);
    gestures.cancel();
    gestures.end(50);
    expect(said()).toEqual(["move 100,200"]);
  });
});

it("presses and releases a wheel button per notch, in the direction asked", () => {
  expect(wheelMasks(0, 2)).toEqual([16, 0, 16, 0]);
  expect(wheelMasks(0, -1)).toEqual([8, 0]);
  expect(wheelMasks(1, 0)).toEqual([64, 0]);
  expect(wheelMasks(-1, 1)).toEqual([16, 0, 32, 0]);
  expect(wheelMasks(0, 500).length).toBe(24);
});

describe("the phone keyboard's text", () => {
  it("types what was added", () => {
    expect(typedSince(KEYBOARD_FILL, `${KEYBOARD_FILL}h`)).toEqual({ backspaces: 0, text: ["h"] });
    expect(typedKeysyms(KEYBOARD_FILL, `${KEYBOARD_FILL}Hi!`)).toEqual([0x48, 0x69, 0x21]);
  });

  it("deletes what was removed, the fill included", () => {
    expect(typedKeysyms(`${KEYBOARD_FILL}ab`, `${KEYBOARD_FILL}a`)).toEqual([KEYSYM.BackSpace]);
    expect(typedKeysyms(KEYBOARD_FILL, KEYBOARD_FILL.slice(1))).toEqual([KEYSYM.BackSpace]);
  });

  it("rewrites the tail a keyboard corrected", () => {
    expect(typedSince("___teh", "___the ")).toEqual({ backspaces: 2, text: ["h", "e", " "] });
    expect(typedSince("___wörld", "___world!")).toEqual({ backspaces: 4, text: ["o", "r", "l", "d", "!"] });
  });

  it("counts an emoji as the one character it deletes as", () => {
    expect(typedSince("_👍", "_👎")).toEqual({ backspaces: 1, text: ["👎"] });
    expect(typedSince("_a👍", "_a")).toEqual({ backspaces: 1, text: [] });
  });

  it("sends Enter for a line break and Tab for a tab", () => {
    expect(typedKeysyms("__", "__\n")).toEqual([KEYSYM.Return]);
    expect(keysymOf("\r")).toBe(KEYSYM.Return);
    expect(keysymOf("\t")).toBe(KEYSYM.Tab);
  });

  it("maps Latin-1 to itself and everything else into X11's Unicode range", () => {
    expect(keysymOf("a")).toBe(0x61);
    expect(keysymOf("ö")).toBe(0xf6);
    expect(keysymOf("€")).toBe(0x010020ac);
    expect(keysymOf("👍")).toBe(0x0101f44d);
  });
});

it("opens the stream on the page's own host, secure when the page is", () => {
  expect(browserStreamUrl("95", { protocol: "https:", host: "box.example.ts.net" })).toBe("wss://box.example.ts.net/api/browsers/95/stream");
  expect(browserStreamUrl("96", { protocol: "http:", host: "127.0.0.1:7317" })).toBe("ws://127.0.0.1:7317/api/browsers/96/stream");
});
