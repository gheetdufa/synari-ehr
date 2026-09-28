import { useId } from "react";

export type LayerTone = "base" | "mid" | "top";

const layerTones: Record<LayerTone, [string, string]> = {
  top: ["#1cc2b2", "#0d9488"],
  mid: ["#5cd2c5", "#2cb8ab"],
  base: ["#aeeae2", "#7fdcd2"],
};

export function LayerDiamond({ tone, className }: { tone: LayerTone; className?: string }) {
  const gradientId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [from, to] = layerTones[tone];
  return (
    <svg className={className} viewBox="0 0 232 132" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="40" y1="10" x2="200" y2="130" gradientUnits="userSpaceOnUse">
          <stop stopColor={from} />
          <stop offset="1" stopColor={to} />
        </linearGradient>
      </defs>
      <path
        d="M116 12 L220 66 L116 120 L12 66 Z"
        fill={`url(#${gradientId})`}
        stroke={`url(#${gradientId})`}
        strokeWidth="18"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function StackMark({ className }: { className?: string }) {
  return (
    <span className={["stack-mark", className].filter(Boolean).join(" ")} aria-hidden="true">
      <LayerDiamond tone="base" className="stack-mark-base" />
      <LayerDiamond tone="mid" className="stack-mark-mid" />
      <LayerDiamond tone="top" className="stack-mark-top" />
    </span>
  );
}

export function Brand({ withWord = true, wordClassName }: { withWord?: boolean; wordClassName?: string }) {
  return (
    <span className="brand">
      <StackMark className="brand-mark" />
      {withWord && <span className={wordClassName ?? "brand-word"}>Synari</span>}
    </span>
  );
}
