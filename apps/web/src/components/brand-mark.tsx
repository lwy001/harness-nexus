/**
 * AgentNexus brand mark.
 *
 * The glyph encodes the product thesis: upstream nodes (left) converge via
 * signal lines on a central nexus node, which re-exposes one connection
 * (right). It is the only place the signal accent appears at full strength
 * alongside the wordmark — restraint everywhere else keeps it memorable.
 *
 * Mark + wordmark are inline SVG/text (no image asset) so they inherit the
 * current color and scale crisply at any size, and so the favicon can mirror
 * the same shape.
 */

type BrandMarkProps = {
  /** Glyph edge length in px. Wordmark tracks relative to this. */
  size?: number;
  className?: string;
};

export function BrandMark({ size = 28, className }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* converging upstream signals */}
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.55">
        <path d="M6 9 L15 16" />
        <path d="M6 23 L15 16" />
        <path d="M9 16 L15 16" />
      </g>
      {/* upstream nodes */}
      <g fill="currentColor" opacity="0.5">
        <circle cx="6" cy="9" r="1.7" />
        <circle cx="6" cy="23" r="1.7" />
        <circle cx="9" cy="16" r="1.7" />
      </g>
      {/* the nexus */}
      <circle cx="15" cy="16" r="3.6" fill="currentColor" />
      {/* re-exposed fan-out */}
      <path
        d="M15 16 L26 16"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.55"
      />
      <circle cx="26" cy="16" r="1.7" fill="currentColor" opacity="0.5" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className}>
      Agent<span className="text-signal">Nexus</span>
    </span>
  );
}

/** Mark + wordmark, locked up as the masthead unit. */
export function Brand({ size = 24, className }: BrandMarkProps) {
  return (
    <span className={`text-signal inline-flex items-center gap-2 ${className ?? ''}`}>
      <BrandMark size={size} />
      <Wordmark className="text-foreground text-[15px] font-semibold tracking-tight" />
    </span>
  );
}
