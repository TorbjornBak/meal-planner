import type { WeekBucket } from "@/lib/spending";

// Single-series weekly-spend bar chart (§8). Server-rendered SVG: thin bars with
// rounded tops anchored to the baseline, recessive axis/gridlines, value labels
// in ink (not the bar color), and a native hover tooltip per bar. No legend —
// the card title names the single series.

const W = 640;
const H = 240;
const PAD = { top: 16, right: 8, bottom: 26, left: 40 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / mag) * mag;
}

/** Rectangle path with only the top corners rounded. */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

export function WeeklySpendChart({ data }: { data: WeekBucket[] }) {
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const baseline = PAD.top + plotH;

  const maxVal = niceMax(Math.max(0, ...data.map((d) => d.total)));
  const band = plotW / data.length;
  const barW = Math.max(2, band - 8); // 2px surface gap between bars

  const y = (v: number) => baseline - (v / maxVal) * plotH;

  const gridlines = [0, 0.5, 1].map((f) => Math.round(maxVal * f));

  return (
    <div style={{ overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label="Weekly grocery spend"
        style={{ maxWidth: W, display: "block" }}
      >
        {/* Gridlines + y labels (recessive) */}
        {gridlines.map((val) => (
          <g key={val}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(val)}
              y2={y(val)}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(val) + 3}
              textAnchor="end"
              fontSize={10}
              fill="var(--muted)"
            >
              {val}
            </text>
          </g>
        ))}

        {/* Bars */}
        {data.map((d, i) => {
          const x = PAD.left + i * band + (band - barW) / 2;
          const h = baseline - y(d.total);
          return (
            <g key={i}>
              {h > 0 && (
                <path d={barPath(x, y(d.total), barW, h, 4)} fill="var(--accent)" />
              )}
              <title>{`Week of ${d.label}: ${Math.round(d.total)} kr`}</title>
              <text
                x={x + barW / 2}
                y={H - 8}
                textAnchor="middle"
                fontSize={9}
                fill="var(--muted)"
              >
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
