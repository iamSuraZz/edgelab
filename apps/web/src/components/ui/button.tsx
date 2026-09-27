import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium ' +
    'transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] ' +
    'disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'bg-[var(--color-primary)] text-[var(--color-primary-foreground)] hover:opacity-90',
        outline:
          'border border-[var(--color-border)] bg-transparent hover:bg-[var(--color-surface-hover)]',
        ghost: 'bg-transparent hover:bg-[var(--color-surface-hover)]',
        destructive: 'bg-[var(--color-destructive)] text-white hover:opacity-90',
      },
      size: {
        sm: 'h-8 px-3',
        default: 'h-9 px-4',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element instead of a <button>, shadcn's asChild pattern. */
    asChild?: boolean;
  };

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps): React.JSX.Element {
  const Component = asChild ? Slot : 'button';
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
