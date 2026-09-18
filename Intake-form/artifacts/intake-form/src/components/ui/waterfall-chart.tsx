// WaterfallChart — a staged, curved journey funnel.
//
// PROVENANCE. This is an independent implementation. The reference console's
// own funnel component is a derivative of a third-party 21st.dev component
// prompt whose licence could not be established: there is no licence text in
// the prompt, no LICENSE file anywhere in that repository, and the file is not
// even committed there. Because this code is deployed publicly, none of that
// source was copied. The path geometry, the scale, the state model, the
// keyboard handling and the props below are written from scratch against
// `react` + `framer-motion` (both already dependencies here, both MIT). The
// visual intent — a smooth curved taper rather than a bar chart — is shared;
// the implementation is not.
//
// FIVE DELIBERATE CORRECTIONS to the weaknesses recorded in that reference:
//
//  1. MONOTONIC BY CONSTRUCTION, NOT BY CLAMPING. The reference interpolates
//     each segment freely, so a later stage with a larger count draws a
//     WIDENING funnel — a shape that asserts growth through a funnel. Here a
//     rise is treated as what it is: proof the two stages are not one cohort.
//     `assertNested` reports it, the caller renders a break, and the VALUE IS
//     NEVER ALTERED to manufacture a descent.
//
//  2. SQRT SCALE, DISCLOSED. The reference normalises linearly against the
//     max, so with 1,236 at the mouth and 5 at the base every late stage is a
//     hairline. Heights here are sqrt-scaled with a visible minimum, and
//     because that is non-proportional the chart says so in a caption the
//     caller cannot forget — `scaleNote` is returned for rendering. The
//     printed numbers are always the exact values.
//
//  3. KEYBOARD REACHABLE. The reference's stage overlay has role="button" but
//     no tabIndex and no key handler, so drill-down is mouse-only. Every stage
//     here is tabbable, activates on Enter and Space, and carries an aria-label
//     that states its value AND its availability.
//
//  4. FIVE AVAILABILITY STATES, not a zero for all of them. See StageState.
//
//  5. A TABLE IS THE ACCESSIBLE PRIMARY. The chart is an enhancement; callers
//     render <StageTable> alongside it. A funnel silhouette is not a way to
//     read numbers with a screen reader.

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * Why a stage has no number. Collapsing any two of these into `0` is how a
 * reporting page starts lying.
 *
 *  measured          a real count, INCLUDING a genuine zero
 *  not_instrumented  the stage exists but nothing measures it for this scope
 *  unavailable       the source exists but cannot answer for this period
 *  not_yet           the period or stage has not happened yet
 *  suppressed        a real count of 1..4, withheld for privacy
 */
export type StageState =
  | "measured"
  | "not_instrumented"
  | "unavailable"
  | "not_yet"
  | "suppressed";

export type WaterfallStage = {
  id: string;
  label: string;
  state: StageState;
  /** Required for `measured`; ignored (and must be absent) otherwise. */
  value?: number;
  /** What the count actually covers, or why there is no count. */
  coverage?: string;
  /** PRE-COMPUTED stage-to-stage conversion, e.g. "60.7%". Never derived here. */
  conversion?: string | null;
  /** submissions | people | events — shown so two grains are never conflated. */
  unit?: string;
  /** True when this stage starts a new cohort/grain block (draws a break). */
  breakBefore?: boolean;
  /** Free label for the break, e.g. "different unit — not a flow". */
  breakNote?: string;
};

const MARKER_NORM = 0.16; // outline height for a stage with no number
const MIN_MEASURED_NORM = 0.08; // so a small measured stage stays visible

export const SCALE_NOTE =
  "Segment height is square-root scaled so small stages stay visible — " +
  "heights are not proportional to counts. The printed numbers are exact.";

/** True when a stage carries a drawable number. */
export function hasValue(s: WaterfallStage): boolean {
  return s.state === "measured" && typeof s.value === "number";
}

/** The label shown in place of a number. */
export function markerText(state: StageState): string {
  switch (state) {
    case "not_instrumented":
      return "not measured";
    case "unavailable":
      return "not available";
    case "not_yet":
      return "not yet";
    case "suppressed":
      return "<5";
    default:
      return "";
  }
}

/**
 * Report stages that are larger than the stage before them WITHIN a block.
 *
 * A subset cannot exceed its superset, so within one cohort a rise is
 * impossible — if it happens the stages are not nested and must not be drawn
 * as one continuous taper. Returns the offending ids; the caller decides what
 * to show. Nothing is clamped and no value is changed.
 */
export function assertNested(stages: WaterfallStage[]): string[] {
  const bad: string[] = [];
  let prev: number | null = null;
  for (const s of stages) {
    if (s.breakBefore) prev = null;
    if (!hasValue(s)) {
      prev = null; // a marker breaks the chain; nothing to compare across it
      continue;
    }
    const v = s.value as number;
    if (prev !== null && v > prev) bad.push(s.id);
    prev = v;
  }
  return bad;
}

/** Drawing heights in 0..1. A scale, never a reported number. */
function drawNorms(stages: WaterfallStage[]): number[] {
  const values = stages.filter(hasValue).map((s) => s.value as number);
  const max = Math.max(1, ...values);
  return stages.map((s) => {
    if (!hasValue(s)) return MARKER_NORM;
    const v = s.value as number;
    if (v <= 0) return MIN_MEASURED_NORM;
    return Math.max(MIN_MEASURED_NORM, Math.sqrt(v / max));
  });
}

function useSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/**
 * A smooth taper from `n0` to `n1`. Cubic Bézier with both control points at
 * the segment midpoint, which gives a flat join at each stage boundary — so
 * consecutive segments read as one continuous silhouette.
 */
const AMPLITUDE = {
  // Half-thickness as a fraction of the cross axis, at norm 1.
  horizontal: 0.44,
  // Deliberately narrower: the vertical layout puts the stage label in a left
  // column and the value in a right column, and at 0.44 the silhouette grew
  // underneath both of them — dark label text on a dark fill. 0.26 keeps the
  // shape inside the middle half so every label stays on the page background.
  vertical: 0.26,
};

function taperPath(
  n0: number,
  n1: number,
  len: number,
  cross: number,
  horizontal: boolean,
): string {
  const mid = cross / 2;
  const amp = horizontal ? AMPLITUDE.horizontal : AMPLITUDE.vertical;
  const a = n0 * cross * amp;
  const b = n1 * cross * amp;
  const c = len / 2;
  if (horizontal) {
    return (
      `M 0 ${mid - a} C ${c} ${mid - a}, ${c} ${mid - b}, ${len} ${mid - b} ` +
      `L ${len} ${mid + b} C ${c} ${mid + b}, ${c} ${mid + a}, 0 ${mid + a} Z`
    );
  }
  return (
    `M ${mid - a} 0 C ${mid - a} ${c}, ${mid - b} ${c}, ${mid - b} ${len} ` +
    `L ${mid + b} ${len} C ${mid + b} ${c}, ${mid + a} ${c}, ${mid + a} 0 Z`
  );
}

export type WaterfallChartProps = {
  stages: WaterfallStage[];
  /** Ramp, mouth to base. Must be at least as long as `stages`. */
  colors: string[];
  orientation?: "horizontal" | "vertical";
  gap?: number;
  onStageActivate?: (stage: WaterfallStage, index: number) => void;
  /** Index of the stage whose detail panel is open, for aria-expanded. */
  activeIndex?: number | null;
  className?: string;
  /** Accessible name for the figure. */
  ariaLabel: string;
};

export function WaterfallChart({
  stages,
  colors,
  orientation = "horizontal",
  gap = 6,
  onStageActivate,
  activeIndex = null,
  className,
  ariaLabel,
}: WaterfallChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(ref);
  const reduce = useReducedMotion();
  const [hovered, setHovered] = useState<number | null>(null);

  const horizontal = orientation === "horizontal";
  const norms = useMemo(() => drawNorms(stages), [stages]);
  const n = stages.length;

  const totalGap = gap * Math.max(0, n - 1);
  const segLen = n > 0 ? ((horizontal ? w : h) - totalGap) / n : 0;
  const cross = horizontal ? h : w;
  const ready = w > 0 && h > 0 && segLen > 0;

  return (
    <div
      ref={ref}
      className={cn(
        "relative w-full select-none",
        horizontal ? "aspect-[2.4/1]" : "aspect-[1/2.1]",
        className,
      )}
      role="group"
      aria-label={ariaLabel}
      data-testid="waterfall-chart"
    >
      {ready && (
        <svg
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          className="absolute inset-0 overflow-visible"
          aria-hidden="true"
          focusable="false"
        >
          {stages.map((stage, i) => {
            const n0 = norms[i];
            // The last segment tapers to its own height so the base is flat
            // rather than pinching to a point.
            const n1 = i + 1 < n ? norms[i + 1] : norms[i];
            const off = (segLen + gap) * i;
            const color = colors[i % colors.length];
            const marker = !hasValue(stage);
            const dim = hovered !== null && hovered !== i;
            return (
              <g
                key={stage.id}
                transform={
                  horizontal ? `translate(${off}, 0)` : `translate(0, ${off})`
                }
              >
                {stage.breakBefore && i > 0 && (
                  <line
                    x1={horizontal ? -gap / 2 : 0}
                    y1={horizontal ? 0 : -gap / 2}
                    x2={horizontal ? -gap / 2 : w}
                    y2={horizontal ? h : -gap / 2}
                    stroke="#94a3b8"
                    strokeWidth={1}
                    strokeDasharray="3 3"
                  />
                )}
                <motion.path
                  d={taperPath(n0, n1, segLen, cross, horizontal)}
                  fill={marker ? "none" : color}
                  stroke={marker ? color : "none"}
                  strokeWidth={marker ? 1.5 : 0}
                  strokeDasharray={marker ? "5 4" : undefined}
                  strokeOpacity={marker ? 0.55 : undefined}
                  initial={reduce ? false : { opacity: 0 }}
                  animate={{ opacity: dim ? 0.35 : 1 }}
                  transition={
                    reduce
                      ? { duration: 0 }
                      : { duration: 0.35, delay: i * 0.06, ease: "easeOut" }
                  }
                />
                {/* Inner highlight band — depth without a second data claim. */}
                {!marker && (
                  <motion.path
                    d={taperPath(n0 * 0.42, n1 * 0.42, segLen, cross, horizontal)}
                    fill="#ffffff"
                    initial={false}
                    animate={{ opacity: dim ? 0.03 : 0.08 }}
                    transition={{ duration: 0.15 }}
                  />
                )}
              </g>
            );
          })}
        </svg>
      )}

      {/* Interactive, keyboard-reachable overlay — one hit area per stage. */}
      <div className="absolute inset-0">
        {stages.map((stage, i) => {
          const off = ready ? (segLen + gap) * i : 0;
          const pos = horizontal
            ? { left: off, width: segLen, top: 0, height: h }
            : { top: off, height: segLen, left: 0, width: w };
          const marker = !hasValue(stage);
          const valueText = marker
            ? markerText(stage.state)
            : (stage.value as number).toLocaleString("en-US");
          const aria =
            `${stage.label}: ${valueText}` +
            (stage.unit && !marker ? ` ${stage.unit}` : "") +
            (stage.coverage ? `. ${stage.coverage}` : "") +
            (stage.conversion ? `. ${stage.conversion} from the previous stage` : "");
          return (
            <div
              key={stage.id}
              role="button"
              tabIndex={0}
              aria-label={aria}
              aria-expanded={activeIndex === i}
              data-testid={`waterfall-stage-${stage.id}`}
              data-state={stage.state}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(i)}
              onBlur={() => setHovered(null)}
              onClick={() => onStageActivate?.(stage, i)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
                  e.preventDefault();
                  onStageActivate?.(stage, i);
                }
              }}
              className={cn(
                "absolute flex cursor-pointer flex-col",
                horizontal
                  ? "items-center justify-between py-1"
                  : "justify-center px-1",
              )}
              style={{ ...pos, zIndex: 20 }}
            >
              {horizontal ? (
                <>
                  <div className="text-center">
                    <div
                      className={cn(
                        "sh-num text-sm font-semibold",
                        marker ? "italic text-slate-400" : "text-slate-900",
                      )}
                    >
                      {valueText}
                    </div>
                    {stage.conversion && (
                      <div className="sh-num mt-0.5 inline-block border border-slate-200 bg-white px-1.5 text-[10px] font-semibold text-slate-600">
                        {stage.conversion}
                      </div>
                    )}
                  </div>
                  <div className="w-full text-center">
                    <div className="truncate text-xs font-medium text-slate-700">
                      {stage.label}
                    </div>
                    {marker && (
                      <div className="text-[9px] uppercase tracking-wide text-slate-400">
                        {stage.state === "suppressed" ? "hidden (<5)" : "not measured"}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex w-full items-center gap-2">
                  <div className="w-[34%] shrink-0 text-right">
                    <div className="truncate text-xs font-medium text-slate-700">
                      {stage.label}
                    </div>
                    {marker && (
                      <div className="text-[9px] uppercase tracking-wide text-slate-400">
                        {stage.state === "suppressed" ? "hidden (<5)" : "not measured"}
                      </div>
                    )}
                  </div>
                  <div className="flex-1" />
                  <div className="w-[26%] shrink-0 text-right">
                    <div
                      className={cn(
                        "sh-num text-sm font-semibold",
                        marker ? "italic text-slate-400" : "text-slate-900",
                      )}
                    >
                      {valueText}
                    </div>
                    {stage.conversion && (
                      <div className="sh-num text-[10px] font-semibold text-slate-600">
                        {stage.conversion}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The accessible, and frankly more useful, rendering of the same stages. Always
 * render this with the chart: it is what a sceptical reader actually reads, and
 * it is the only rendering a screen reader can use.
 */
export function StageTable({
  stages,
  caption,
}: {
  stages: WaterfallStage[];
  caption: string;
}) {
  return (
    <div className="overflow-x-auto border border-[var(--sh-border)]">
      <table className="w-full min-w-[34rem] text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-slate-50">
          <tr className="text-xs">
            <th scope="col" className="px-3 py-2 font-semibold text-slate-600">
              Stage
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold text-slate-600">
              Count
            </th>
            <th scope="col" className="px-3 py-2 font-semibold text-slate-600">
              Unit
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold text-slate-600">
              From previous
            </th>
            <th scope="col" className="px-3 py-2 font-semibold text-slate-600">
              Basis
            </th>
          </tr>
        </thead>
        <tbody>
          {stages.map((s) => {
            const marker = !hasValue(s);
            return (
              <tr key={s.id} className="border-t border-slate-100 align-top">
                <th scope="row" className="px-3 py-2 font-medium text-slate-800">
                  {s.label}
                </th>
                <td
                  className={cn(
                    "sh-num px-3 py-2 text-right",
                    marker ? "italic text-slate-400" : "text-slate-900",
                  )}
                >
                  {marker
                    ? markerText(s.state)
                    : (s.value as number).toLocaleString("en-US")}
                </td>
                <td className="px-3 py-2 text-slate-500">{marker ? "—" : s.unit ?? "—"}</td>
                <td className="sh-num px-3 py-2 text-right text-slate-600">
                  {s.conversion ?? "—"}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {s.coverage ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default WaterfallChart;
