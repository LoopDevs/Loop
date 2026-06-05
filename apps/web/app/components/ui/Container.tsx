/**
 * Container — consistent page width + horizontal gutter.
 *
 * One place that owns the app's max-width rhythm so pages don't each
 * reinvent `container mx-auto px-4`. `width` picks the max-width;
 * the gutter is responsive and identical everywhere.
 */
type Width = 'sm' | 'md' | 'lg' | 'xl' | 'full';

export interface ContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  width?: Width;
  as?: 'div' | 'section' | 'main' | 'header' | 'footer';
}

const WIDTH: Record<Width, string> = {
  sm: 'max-w-2xl',
  md: 'max-w-4xl',
  lg: 'max-w-6xl',
  xl: 'max-w-7xl',
  full: 'max-w-none',
};

export function Container({
  width = 'xl',
  as: Tag = 'div',
  className = '',
  children,
  ...props
}: ContainerProps): React.JSX.Element {
  return (
    <Tag
      className={`mx-auto w-full px-4 sm:px-6 lg:px-8 ${WIDTH[width]} ${className}`.trim()}
      {...props}
    >
      {children}
    </Tag>
  );
}
