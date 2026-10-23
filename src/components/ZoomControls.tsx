import { Minus, Plus } from "lucide-react";
import "./ZoomControls.css";
import { useT } from "../lib/i18n.ts";
import { ZOOM_STEP } from "../lib/zoomGestures.ts";

export interface ZoomControlsProps {
  zoom: number;
  min: number;
  max: number;
  /** a zoom from the buttons, around the middle of the view */
  onZoom: (next: number) => void;
}

/** Zoom out, the level (a press fits the width again) and zoom in, for the document views. */
export function ZoomControls({ zoom, min, max, onZoom }: ZoomControlsProps) {
  const t = useT();
  return (
    <div className="zoom-controls">
      <button type="button" className="icon-button" onClick={() => onZoom(zoom / ZOOM_STEP)} disabled={zoom <= min + 1e-6} aria-label={t("Zoom out")} title={t("Zoom out")}>
        <Minus aria-hidden="true" />
      </button>
      <button type="button" className="zoom-controls-level" onClick={() => onZoom(1)} aria-label={t("Fit to width")} title={t("Fit to width")}>
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" className="icon-button" onClick={() => onZoom(zoom * ZOOM_STEP)} disabled={zoom >= max - 1e-6} aria-label={t("Zoom in")} title={t("Zoom in")}>
        <Plus aria-hidden="true" />
      </button>
    </div>
  );
}
