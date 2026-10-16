/**
 * What components/BrowserView.tsx uses of noVNC 1.7.0, which ships no types. The two
 * underscored members are its internals: the package is pinned to an exact version because of
 * them, and the component checks they exist before it relies on them.
 */
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean; credentials?: { password?: string } });
    scaleViewport: boolean;
    clipViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    viewOnly: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
    focus(options?: FocusOptions): void;
    blur(): void;
    /** `down` omitted: a press and a release */
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    /** element coordinates of the canvas, and an RFB button mask */
    _sendMouse?(x: number, y: number, mask: number): void;
    _canvas?: HTMLCanvasElement;
  }
}
