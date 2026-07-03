/**
 * `/styleguide` — the design-system "kitchen sink".
 *
 * A single page that renders every design token (colour ramps, semantic
 * aliases, radii, shadows, type scale) and every `components/ui`
 * primitive in all its variants/sizes/states. Purpose: a hand-off
 * surface for a designer (or a design tool) to see + overhaul the whole
 * Loop design language at a glance. Tokens live in `app/app.css`
 * (@theme); this page just consumes them, so retuning a token there
 * re-skins both the app AND this page.
 *
 * Not linked from anywhere and `noindex`. It's an internal design
 * surface — gate behind admin or delete before a public launch if you
 * don't want it reachable.
 */
import { Button, Input, Card, Badge, Avatar, Container, LoopLogo } from '~/components/ui';
import { Spinner } from '~/components/ui/Spinner';
import { Skeleton } from '~/components/ui/Skeleton';

export function meta(): Array<Record<string, string>> {
  return [
    { title: 'Loop — Design system / styleguide' },
    { name: 'robots', content: 'noindex, nofollow' },
  ];
}

// Full literal class names (NOT `bg-blue-${n}`) so Tailwind v4's source
// scanner sees each one and emits the utility + its theme var — a
// constructed class name wouldn't be generated.
const BLUE = [
  'bg-blue-50',
  'bg-blue-100',
  'bg-blue-200',
  'bg-blue-300',
  'bg-blue-400',
  'bg-blue-500',
  'bg-blue-600',
  'bg-blue-700',
  'bg-blue-800',
  'bg-blue-900',
  'bg-blue-950',
];
const GRAY = [
  'bg-gray-50',
  'bg-gray-100',
  'bg-gray-200',
  'bg-gray-300',
  'bg-gray-400',
  'bg-gray-500',
  'bg-gray-600',
  'bg-gray-700',
  'bg-gray-800',
  'bg-gray-900',
  'bg-gray-950',
];
const SEMANTIC = [
  'bg-canvas',
  'bg-surface',
  'bg-surface-subtle',
  'bg-surface-muted',
  'bg-line',
  'bg-line-strong',
  'bg-ink',
  'bg-ink-muted',
  'bg-ink-subtle',
];
const BADGE_TONES = ['neutral', 'brand', 'success', 'warning', 'danger'] as const;
const BADGE_VARIANTS = ['soft', 'solid', 'outline'] as const;
const BTN_VARIANTS = ['primary', 'secondary', 'outline', 'ghost', 'link', 'destructive'] as const;
const BTN_SIZES = ['sm', 'md', 'lg', 'xl'] as const;

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="space-y-4 border-t border-line pt-10">
      <div>
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
        {subtitle ? <p className="mt-1 text-sm text-ink-muted">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <span className="w-24 shrink-0 font-mono text-xs text-ink-subtle">{label}</span>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

/** A colour swatch. `cls` is a full literal `bg-*` utility. */
function Swatch({ cls }: { cls: string }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className={`h-12 w-12 rounded-md border border-line ${cls}`} />
      <span className="font-mono text-[10px] text-ink-subtle">{cls.replace('bg-', '')}</span>
    </div>
  );
}

const StarIcon = (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path d="M10 1.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L10 15l-5.3 2.8 1-5.8L1.5 7.7l5.9-.9L10 1.5z" />
  </svg>
);

export default function StyleguideRoute(): React.JSX.Element {
  return (
    <Container width="lg">
      <div className="space-y-10 py-12">
        <header className="space-y-2">
          <div className="flex items-center gap-3">
            <LoopLogo className="h-7 w-auto text-ink" />
            <span className="rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-ink-muted">
              design system
            </span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-ink">Styleguide</h1>
          <p className="max-w-2xl text-sm text-ink-muted">
            Every design token + UI primitive in one place — the “clean tech” Loop language:
            confident blue accent, cool-slate neutrals, hairline borders, near-flat surfaces, sharp
            2px geometry, Inter. Tokens are defined once in{' '}
            <code className="rounded bg-surface-muted px-1 font-mono text-xs">app/app.css</code> (
            <code className="rounded bg-surface-muted px-1 font-mono text-xs">@theme</code>). Light
            mode only.
          </p>
        </header>

        <Section
          title="Colour — brand blue"
          subtitle="Overrides Tailwind's blue-* ramp, so every existing bg-blue-600 etc. re-skins from here. blue-600 = primary action; blue-500 = focus ring."
        >
          <div className="flex flex-wrap gap-3">
            {BLUE.map((c) => (
              <Swatch key={c} cls={c} />
            ))}
          </div>
        </Section>

        <Section
          title="Colour — neutrals (cool slate)"
          subtitle="Overrides Tailwind's gray-* ramp. Cool greys read more 'tech' than warm."
        >
          <div className="flex flex-wrap gap-3">
            {GRAY.map((c) => (
              <Swatch key={c} cls={c} />
            ))}
          </div>
        </Section>

        <Section
          title="Colour — semantic tokens"
          subtitle="Named aliases so components read intentionally instead of guessing greys. (There's no brand-* ramp — the accent is blue-* directly.)"
        >
          <div className="flex flex-wrap gap-3">
            {SEMANTIC.map((c) => (
              <Swatch key={c} cls={c} />
            ))}
          </div>
        </Section>

        <Section title="Type scale" subtitle="Inter, with financial numeric features (cv11/ss01).">
          <div className="space-y-2">
            <p className="text-4xl font-semibold tracking-tight text-ink">
              Display 4xl · $1,234.56
            </p>
            <p className="text-2xl font-semibold text-ink">Heading 2xl · £987.00</p>
            <p className="text-lg font-medium text-ink">Subhead lg</p>
            <p className="text-base text-ink">
              Body base — the quick brown fox jumps over 13 lazy dogs.
            </p>
            <p className="text-sm text-ink-muted">Small · muted secondary text.</p>
            <p className="text-xs text-ink-subtle">Extra-small · captions, timestamps.</p>
            <p className="font-mono text-sm text-ink">Mono · GAXY…3QF7 · order_id · 0.02 XLM</p>
          </div>
        </Section>

        <Section
          title="Radii & shadows"
          subtitle="Sharp 2px corners everywhere; soft, low, cool-tinted elevation."
        >
          <Row label="radius">
            {(
              [
                'rounded-sm',
                'rounded-md',
                'rounded-lg',
                'rounded-xl',
                'rounded-2xl',
                'rounded-full',
              ] as const
            ).map((r) => (
              <div key={r} className="flex flex-col items-center gap-1">
                <div className={`h-12 w-12 border border-line-strong bg-surface-muted ${r}`} />
                <span className="font-mono text-[10px] text-ink-subtle">{r}</span>
              </div>
            ))}
          </Row>
          <Row label="shadow">
            {(['shadow-xs', 'shadow-sm', 'shadow-md', 'shadow-lg', 'shadow-xl'] as const).map(
              (s) => (
                <div key={s} className="flex flex-col items-center gap-1">
                  <div className={`h-12 w-16 rounded-md bg-surface ${s}`} />
                  <span className="font-mono text-[10px] text-ink-subtle">{s}</span>
                </div>
              ),
            )}
          </Row>
        </Section>

        <Section title="Button" subtitle="6 variants × 4 sizes, plus loading / disabled / icons.">
          {BTN_VARIANTS.map((v) => (
            <Row key={v} label={v}>
              {BTN_SIZES.map((s) => (
                <Button key={s} variant={v} size={s}>
                  {s.toUpperCase()}
                </Button>
              ))}
            </Row>
          ))}
          <Row label="states">
            <Button loading>Loading</Button>
            <Button disabled>Disabled</Button>
            <Button leftIcon={StarIcon}>Left icon</Button>
            <Button variant="outline" rightIcon={StarIcon}>
              Right icon
            </Button>
          </Row>
        </Section>

        <Section title="Badge" subtitle="5 tones × 3 variants.">
          {BADGE_VARIANTS.map((v) => (
            <Row key={v} label={v}>
              {BADGE_TONES.map((t) => (
                <Badge key={t} tone={t} variant={v}>
                  {t}
                </Badge>
              ))}
            </Row>
          ))}
        </Section>

        <Section title="Input" subtitle="Label, hint, error, icons.">
          <div className="grid max-w-xl gap-4 sm:grid-cols-2">
            <Input label="Email" placeholder="you@example.com" />
            <Input
              label="With hint"
              hint="We'll send a one-time code."
              placeholder="you@example.com"
            />
            <Input
              label="With error"
              error="That email doesn't look right."
              defaultValue="not-an-email"
            />
            <Input label="With icon" leftIcon={StarIcon} placeholder="Search merchants" />
          </div>
        </Section>

        <Section title="Card" subtitle="Elevations × padding; interactive hover-lift.">
          <div className="grid gap-4 sm:grid-cols-3">
            {(['none', 'sm', 'md'] as const).map((e) => (
              <Card key={e} elevation={e} padding="md">
                <p className="text-sm font-medium text-ink">elevation={e}</p>
                <p className="mt-1 text-sm text-ink-muted">
                  Near-flat white panel with a hairline border + 2px corners.
                </p>
              </Card>
            ))}
            <Card interactive padding="md">
              <p className="text-sm font-medium text-ink">interactive</p>
              <p className="mt-1 text-sm text-ink-muted">
                Hover me — lifts for clickable rows/tiles.
              </p>
            </Card>
          </div>
        </Section>

        <Section title="Avatar · Spinner · Skeleton">
          <Row label="avatar">
            {(['sm', 'md', 'lg'] as const).map((s) => (
              <Avatar key={s} size={s} name="Loop User" />
            ))}
          </Row>
          <Row label="spinner">
            {(['sm', 'md', 'lg'] as const).map((s) => (
              <Spinner key={s} size={s} />
            ))}
          </Row>
          <Row label="skeleton">
            <div className="w-64 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-24 w-full" />
            </div>
          </Row>
        </Section>
      </div>
    </Container>
  );
}
