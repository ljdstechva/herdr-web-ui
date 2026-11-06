import "./ModelChip.css";
import { modelEffortLabel } from "../lib/modelName.ts";
import { useT } from "../lib/i18n.ts";

/**
 * The model and effort a subagent runs on, as one pill: `Opus 5.5 xhigh`, the effort word in the
 * strong face so the two read apart. The raw id and the effort are its title and its spoken name.
 * Draws nothing when neither is known.
 */
export function ModelChip({ model, effort, className }: { model: string | null | undefined; effort: string | null | undefined; className?: string }) {
  const t = useT();
  const label = modelEffortLabel(model, effort);
  if (label === null) return null;
  const said = model && label.effort ? t("Model {model}, effort {effort}", { model, effort: label.effort })
    : model ? t("Model {model}", { model }) : t("Reasoning effort: {effort}", { effort: label.effort ?? "" });
  return (
    <span className={`model-chip${className ? ` ${className}` : ""}`} title={said} aria-label={said} role="img">
      {label.model && <span className={`model-chip-name${label.model.named ? "" : " is-id"}`}>{label.model.text}</span>}
      {label.effort && <span className="model-chip-effort">{label.effort}</span>}
    </span>
  );
}
