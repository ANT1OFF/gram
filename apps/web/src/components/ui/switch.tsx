import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@/lib/utils";

/**
 * An on/off control. It renders a native button, so a `<label htmlFor>` names it and clicking the
 * label flips it.
 */
function Switch({ className, ...props }: Omit<SwitchPrimitive.Root.Props, "nativeButton">) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      nativeButton
      render={<button type="button" />}
      className={cn(
        "peer inline-flex h-4.5 w-8 shrink-0 cursor-default items-center rounded-full border border-transparent transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:bg-primary data-disabled:opacity-50 data-unchecked:bg-input dark:data-unchecked:bg-input/80",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3.5 rounded-full bg-background shadow-xs transition-transform duration-(--dur-move-fast) data-checked:translate-x-[calc(100%+1px)] data-unchecked:translate-x-px dark:data-checked:bg-primary-foreground"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
