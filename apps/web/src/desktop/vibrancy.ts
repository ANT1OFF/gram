import { isTranslucentLook, type LookId } from "@gram/themes";

/**
 * `data-vibrancy` for <html>: `native` when the desktop shell puts window vibrancy / Mica behind the
 * app, so a translucent look lets it show through; absent otherwise, where the look paints its own
 * backdrop. Reduced transparency keeps surfaces opaque, as the shell does.
 */
export const vibrancyAttribute = (
  look: LookId,
  hasBridge: boolean,
  reducedTransparency: boolean,
): "native" | undefined =>
  hasBridge && isTranslucentLook(look) && !reducedTransparency ? "native" : undefined;
