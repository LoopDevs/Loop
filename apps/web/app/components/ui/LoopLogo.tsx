/**
 * Loop wordmark — inlined SVG (not an <img src>) so it renders as
 * crisp vector markup, inherits `currentColor`, and never shows the
 * rasterisation/scaling artefacts an <img> can.
 *
 * Sizing: set the height on `className` (e.g. `h-7`) and keep
 * `w-auto`; the viewBox + `preserveAspectRatio` derive the width from
 * the 172.22:71 aspect ratio. Colour follows the surrounding text
 * colour (`text-ink` at call sites).
 *
 * Crispness: `shapeRendering="geometricPrecision"` makes Chrome favour
 * edge accuracy over speed, and the navbar dropped its `backdrop-blur`
 * so the mark isn't pushed onto a lower-quality compositing layer. On
 * a 1x (non-retina) display, thin vector curves still alias a little —
 * a rasterisation limit, not something CSS resolves.
 */
export function LoopLogo({ className = '' }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 172.22 71"
      fill="currentColor"
      role="img"
      aria-label="Loop"
      preserveAspectRatio="xMidYMid meet"
      shapeRendering="geometricPrecision"
      className={className}
    >
      <path d="M0,52V0h10v43h20v9H0Z" />
      <path d="M70.06,46.56c-4.25,4.27-9.4,6.41-15.44,6.41s-11.2-2.14-15.44-6.41c-4.25-4.27-6.37-9.43-6.37-15.48s2.11-11.34,6.34-15.59c4.22-4.25,9.38-6.37,15.48-6.37s11.2,2.12,15.44,6.37,6.37,9.44,6.37,15.59-2.12,11.21-6.37,15.48ZM45.91,40.08c2.35,2.5,5.26,3.74,8.71,3.74s6.36-1.25,8.71-3.74c2.35-2.5,3.53-5.5,3.53-9s-1.18-6.64-3.53-9.11c-2.35-2.47-5.26-3.71-8.71-3.71s-6.36,1.24-8.71,3.71c-2.35,2.47-3.53,5.51-3.53,9.11s1.18,6.5,3.53,9Z" />
      <path d="M116.94,46.56c-4.25,4.27-9.4,6.41-15.44,6.41s-11.2-2.14-15.44-6.41c-4.25-4.27-6.37-9.43-6.37-15.48s2.11-11.34,6.34-15.59c4.22-4.25,9.38-6.37,15.48-6.37s11.2,2.12,15.44,6.37,6.37,9.44,6.37,15.59-2.12,11.21-6.37,15.48ZM92.78,40.08c2.35,2.5,5.26,3.74,8.71,3.74s6.36-1.25,8.71-3.74c2.35-2.5,3.53-5.5,3.53-9s-1.18-6.64-3.53-9.11c-2.35-2.47-5.26-3.71-8.71-3.71s-6.36,1.24-8.71,3.71c-2.35,2.47-3.53,5.51-3.53,9.11s1.18,6.5,3.53,9Z" />
      <path d="M165.62,15.46c-4.4-4.21-9.74-6.32-16.01-6.32-4.75,0-8.96,1.19-12.61,3.58v-2.72h-10v61h10v-21.99c3.67,2.42,7.87,3.63,12.61,3.63,6.27,0,11.6-2.12,16.01-6.36,4.4-4.24,6.6-9.36,6.6-15.36s-2.2-11.25-6.6-15.46ZM157.88,40.08c-2.35,2.5-5.26,3.74-8.71,3.74s-6.36-1.25-8.71-3.74c-2.03-2.15-3.18-4.68-3.46-7.58v-2.87c.28-2.97,1.43-5.52,3.46-7.66,2.35-2.47,5.26-3.71,8.71-3.71s6.36,1.24,8.71,3.71c2.35,2.47,3.53,5.51,3.53,9.11s-1.18,6.5-3.53,9Z" />
    </svg>
  );
}
