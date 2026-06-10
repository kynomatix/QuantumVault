"use client"

import * as React from "react"
import * as SheetPrimitive from "@radix-ui/react-dialog"
import { cva, type VariantProps } from "class-variance-authority"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const Sheet = SheetPrimitive.Root

const SheetTrigger = SheetPrimitive.Trigger

const SheetClose = SheetPrimitive.Close

const SheetPortal = SheetPrimitive.Portal

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    className={cn(
      "fixed inset-0 z-50 bg-black/80  data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
    ref={ref}
  />
))
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName

const sheetVariants = cva(
  "fixed z-50 gap-4 bg-background p-6 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 data-[state=open]:animate-in data-[state=closed]:animate-out",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
        bottom:
          "inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
        left: "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
        right:
          "inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm",
      },
    },
    defaultVariants: {
      side: "right",
    },
  }
)

interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {}

const SciFiCloseButton = () => (
  <svg 
    width="16" 
    height="160" 
    viewBox="0 0 16 160" 
    fill="none" 
    className="transition-all duration-300"
  >
    {/* Trapezoid shape - narrower, much taller */}
    <path 
      d="M0 0 L6 0 L16 12 L16 148 L6 160 L0 160 Z" 
      fill="currentColor" 
      fillOpacity="0.2"
      stroke="currentColor"
      strokeWidth="1"
      strokeOpacity="0.4"
    />
    {/* Inner accent line */}
    <path 
      d="M2 4 L6 4 L13 14 L13 146 L6 156 L2 156 Z" 
      fill="none"
      stroke="currentColor"
      strokeWidth="0.5"
      strokeOpacity="0.4"
    />
    {/* Small arrow pointing right */}
    <path 
      d="M4 77 L10 80 L4 83 Z" 
      fill="currentColor"
      fillOpacity="0.9"
    />
  </svg>
)

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(({ side = "right", className, children, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <SheetPrimitive.Content
      ref={ref}
      className={cn(sheetVariants({ side }), "overflow-visible border-l border-l-primary/30", className)}
      {...props}
    >
      {/* Sci-fi trapezoid close button - always tappable; tucks + slides out on hover (desktop) */}
      <SheetClose asChild>
        <button 
          tabIndex={-1}
          aria-label="Close panel"
          className={cn(
            "absolute left-0 top-1/2 -translate-y-1/2 z-[60] cursor-pointer transition-all duration-300 ease-out focus:outline-none",
            // Touch / no-hover devices: rest fully visible in brand color so it's easy to tap
            "translate-x-0 text-primary/80",
            // Hover-capable (desktop): tuck off the edge, slide out + glow on hover
            "[@media(hover:hover)]:-translate-x-2.5 [@media(hover:hover)]:text-muted-foreground",
            "[@media(hover:hover)]:hover:translate-x-0 [@media(hover:hover)]:hover:text-primary",
            "[@media(hover:hover)]:hover:[filter:drop-shadow(0_0_10px_currentColor)]"
          )}
        >
          <SciFiCloseButton />
          <span className="sr-only">Close</span>
        </button>
      </SheetClose>
      {children}
    </SheetPrimitive.Content>
  </SheetPortal>
))
SheetContent.displayName = SheetPrimitive.Content.displayName

const SheetHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-2 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
SheetHeader.displayName = "SheetHeader"

const SheetFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
SheetFooter.displayName = "SheetFooter"

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold text-foreground", className)}
    {...props}
  />
))
SheetTitle.displayName = SheetPrimitive.Title.displayName

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
SheetDescription.displayName = SheetPrimitive.Description.displayName

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
