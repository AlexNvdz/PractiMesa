import { choice, field } from "@/components/ui";
import { PLAN_LABEL } from "./api";

type Plan = "SINGLE" | "MULTI";
const labelClass = "mb-1.5 block text-sm font-medium text-ink-2";

/** Plan + location limit (Q25: SINGLE = 1 always, MULTI up to 5). Limits below `locations` are disabled. */
export function PlanFields({
  plan,
  onPlan,
  max,
  onMax,
  locations = 0,
}: {
  plan: Plan;
  onPlan: (plan: Plan) => void;
  max: number;
  onMax: (max: number) => void;
  locations?: number;
}) {
  return (
    <>
      <fieldset>
        <legend className={labelClass}>Plan</legend>
        <div className="grid grid-cols-2 gap-2">
          {(["SINGLE", "MULTI"] as const).map((value) => (
            <label key={value} className={choice}>
              <input type="radio" name="plan" checked={plan === value} onChange={() => onPlan(value)} className="sr-only" />
              {PLAN_LABEL[value]}
            </label>
          ))}
        </div>
      </fieldset>
      {plan === "MULTI" ? (
        <label className="block">
          <span className={labelClass}>Tope de sedes</span>
          <select value={max} onChange={(e) => onMax(Number(e.target.value))} className={`${field} figures`}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n} disabled={n < locations}>
                {n} {n === 1 ? "sede" : "sedes"}
                {n < locations ? " (tiene más)" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="text-sm text-muted">El plan {PLAN_LABEL.SINGLE} siempre tiene 1 sede.</p>
      )}
    </>
  );
}
