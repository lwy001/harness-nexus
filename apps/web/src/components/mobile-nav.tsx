import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { MenuIcon, XIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Mobile navigation drawer.
 *
 * The desktop layout hides the sidebar below `md`. Rather than leave small
 * screens without navigation (the old gap), this slides the same nav in from
 * the left on demand. It auto-closes on route change so a tap navigates and
 * dismisses in one motion, and traps focus while open (Radix Dialog).
 */
export function MobileNav({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  // Close whenever the route changes (the nav links live inside `children`).
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation">
          <MenuIcon className="size-5" />
        </Button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="bg-foreground/40 fixed inset-0 z-40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="bg-background fixed inset-y-0 left-0 z-50 flex w-72 max-w-[80vw] flex-col border-r p-4 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left"
          aria-description="Site navigation"
        >
          <div className="flex items-center justify-between">
            <span className="text-foreground text-sm font-semibold tracking-tight">Menu</span>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close navigation">
                <XIcon className="size-5" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <nav className="mt-4 flex flex-col gap-1">{children}</nav>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
