import NumberFlow, { type Format, type NumberFlowElement } from "@number-flow/react";
import { easingCss } from "@gram/themes";
import { useRef } from "react";

import { COUNT_UP_STEP_MS, useCountUp } from "./count-up";
import { useLookMotion, useMotionLevel } from "./hooks";

/**
 * A number whose digits roll to new values (NumberFlow); changes instantly unless motion is Full.
 * With `countUp` it runs through the values in between as well (`useCountUp`), for a figure that
 * accumulates, like tokens or cost; the rolls are shortened to keep pace with the steps.
 */
export function NumberTicker({
  value,
  format,
  className,
  countUp = false,
}: {
  value: number;
  format?: Format;
  className?: string;
  countUp?: boolean;
}) {
  const level = useMotionLevel();
  const look = useLookMotion();
  const counting = countUp && level === "full";
  const element = useRef<NumberFlowElement>(null);
  const shown = useCountUp(value, counting, element);
  const timing = {
    duration: counting ? COUNT_UP_STEP_MS * 3 : Math.max(400, look.durations.slow * 3),
    easing: easingCss(look.easing.out),
  };
  return (
    <NumberFlow
      ref={element}
      value={shown}
      animated={level === "full"}
      respectMotionPreference={false}
      transformTiming={timing}
      spinTiming={timing}
      {...(format ? { format } : {})}
      {...(className ? { className } : {})}
    />
  );
}
