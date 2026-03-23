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

    const borderClass =
      error !== undefined
        ? 'border-red-500'
        : focused
          ? 'border-blue-500'
          : 'border-gray-300 dark:border-gray-600';

    const paddingClass =
      leftIcon !== undefined && rightIcon !== undefined
        ? 'pl-10 pr-10'
        : leftIcon !== undefined
          ? 'pl-10'
          : rightIcon !== undefined
            ? 'pr-10'
            : '';

    const inputClass =
      `w-full px-3 py-2 text-sm bg-white dark:bg-gray-800 border rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed ${borderClass} ${paddingClass} ${className}`.trim();

    return (
      <div className="w-full">
        {label !== undefined && (
          <label
            htmlFor={inputId}
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
          >
            {label}
            {required === true && <span className="text-red-500 ml-1">*</span>}
          </label>
        )}
        <div className="relative">
          {leftIcon !== undefined && (
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500">
              {leftIcon}
            </div>
          )}
          <input
            ref={ref}
            id={inputId}
            type={type}
            required={required}
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
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500">
              {rightIcon}
            </div>
          )}
        </div>
        {error !== undefined && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
        {hint !== undefined && error === undefined && (
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{hint}</p>
        )}
      </div>
    );
  },
);

Input.displayName = 'Input';
