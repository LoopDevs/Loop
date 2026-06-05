import { forwardRef } from 'react';

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'link' | 'destructive';
type Size = 'sm' | 'md' | 'lg' | 'xl';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

// Loop design language — clean tech, blue accent, 2px corners.
// `rounded-md` resolves to 2px via the @theme radius tokens.
const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white shadow-xs border border-transparent',
  secondary: 'bg-gray-100 hover:bg-gray-200 active:bg-gray-300 text-ink border border-transparent',
  outline: 'bg-white border border-line-strong hover:bg-gray-50 hover:border-gray-400 text-ink',
  ghost:
    'hover:bg-gray-100 active:bg-gray-200 text-ink-muted hover:text-ink border border-transparent',
  link: 'text-blue-600 hover:text-blue-700 underline-offset-4 hover:underline',
  destructive:
    'bg-red-600 hover:bg-red-700 active:bg-red-800 text-white shadow-xs border border-transparent',
};

const SIZES: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-5 py-2.5 text-[0.9375rem]',
  xl: 'px-7 py-3.5 text-base',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      disabled,
      loading,
      leftIcon,
      rightIcon,
      children,
      className = '',
      type = 'button',
      ...props
    },
    ref,
  ) => {
    const base =
      'inline-flex items-center justify-center gap-2 min-h-[44px] rounded-md font-medium tracking-[-0.01em] transition-[background-color,border-color,color,box-shadow] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:opacity-50 disabled:cursor-not-allowed';
    const classes = `${base} ${VARIANTS[variant]} ${SIZES[size]} ${className}`.trim();

    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled === true || loading === true}
        // Announce loading state to AT. Without `aria-busy`, a screen
        // reader user only heard the button label; the visible spinner
        // had no text equivalent so the loading transition was silent.
        aria-busy={loading === true ? true : undefined}
        className={classes}
        {...props}
      >
        {loading === true && (
          <svg
            // `aria-hidden` because the spinner is decorative — the
            // `aria-busy` attribute already conveys the state and we
            // don't want AT to announce "img" or anything on top of it.
            aria-hidden="true"
            className="animate-spin h-4 w-4"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        )}
        {loading !== true && leftIcon}
        <span className={loading === true ? 'opacity-0' : ''}>{children}</span>
        {loading !== true && rightIcon}
      </button>
    );
  },
);

Button.displayName = 'Button';
