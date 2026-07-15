import { forwardRef, useState, useId } from 'react';

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label?: string | undefined;
  error?: string | undefined;
  hint?: string | undefined;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  onChange?: ((value: string) => void) | undefined;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      type = 'text',
      label,
      error,
      hint,
      leftIcon,
      rightIcon,
      className = '',
      onChange,
      onFocus,
      onBlur,
      required,
      id,
      ...props
    },
    ref,
  ) => {
    const [focused, setFocused] = useState(false);
    const generatedId = useId();
    const inputId = id ?? (label !== undefined ? generatedId : undefined);
    // Stable ids for the error / hint nodes so `aria-describedby` can
    // point at them. Without this, AT users heard the input label but
    // got no association to the error message displayed below it (it
    // rendered silently next to the field). `aria-invalid` also flips
    // when `error` is set so the state is announced on focus.
    const errorId = error !== undefined && inputId !== undefined ? `${inputId}-error` : undefined;
    const hintId = hint !== undefined && inputId !== undefined ? `${inputId}-hint` : undefined;
    const describedBy = [errorId, hintId].filter((v): v is string => v !== undefined).join(' ');

    const borderClass =
      error !== undefined ? 'border-red-500' : focused ? 'border-blue-500' : 'border-line-strong';

    const paddingClass =
      leftIcon !== undefined && rightIcon !== undefined
        ? 'ps-10 pe-10'
        : leftIcon !== undefined
          ? 'ps-10'
          : rightIcon !== undefined
            ? 'pe-10'
            : '';

    const inputClass =
      `w-full px-3.5 py-2.5 text-[0.9375rem] bg-white text-ink placeholder:text-ink-subtle border rounded-md transition-[border-color,box-shadow] duration-150 focus:outline-none focus:ring-4 focus:ring-blue-500/12 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-gray-50 ${borderClass} ${paddingClass} ${className}`.trim();

    return (
      <div className="w-full">
        {label !== undefined && (
          <label htmlFor={inputId} className="block text-sm font-medium text-ink mb-1.5">
            {label}
            {required === true && <span className="text-red-500 ms-1">*</span>}
          </label>
        )}
        <div className="relative">
          {leftIcon !== undefined && (
            <div className="absolute start-3 top-1/2 -translate-y-1/2 text-ink-subtle">
              {leftIcon}
            </div>
          )}
          <input
            ref={ref}
            id={inputId}
            type={type}
            required={required}
            aria-invalid={error !== undefined ? true : undefined}
            aria-describedby={describedBy !== '' ? describedBy : undefined}
            className={inputClass}
            onChange={(e) => onChange?.(e.target.value)}
            onFocus={(e) => {
              setFocused(true);
              onFocus?.(e);
            }}
            onBlur={(e) => {
              setFocused(false);
              onBlur?.(e);
            }}
            suppressHydrationWarning
            {...props}
          />
          {rightIcon !== undefined && (
            <div className="absolute end-3 top-1/2 -translate-y-1/2 text-ink-subtle">
              {rightIcon}
            </div>
          )}
        </div>
        {error !== undefined && (
          <p id={errorId} className="mt-1.5 text-sm text-red-600">
            {error}
          </p>
        )}
        {hint !== undefined && error === undefined && (
          <p id={hintId} className="mt-1.5 text-sm text-ink-muted">
            {hint}
          </p>
        )}
      </div>
    );
  },
);

Input.displayName = 'Input';
