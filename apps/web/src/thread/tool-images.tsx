import {
  splitToolImageOutput,
  type InlineToolImage,
  type ThreadId,
  type ToolImageData,
} from "@gram/contracts";
import { ImageOff } from "lucide-react";
import { createContext, use } from "react";

import { imageDataUrl, useAttachmentImage } from "@/panels/files/image-preview";
import { Hint } from "@/components/hint";

import { AttachmentLightbox } from "./attachment-lightbox";
import { basename, toolNameOf, type AnyToolPart } from "./parts";
import { missingToolImageLabel, toolImageName } from "./tool-group-model";

/**
 * The images a message's tool calls returned, where every tool card under that message can find its
 * own. A context rather than a prop: the cards sit below `ToolGroup` and eight card components, none
 * of which has anything else to do with images.
 */
export const ToolImagesContext = createContext<{
  threadId: ThreadId;
  byCall: ReadonlyMap<string, readonly ToolImageData[]>;
} | null>(null);

/** A source is only a candidate: attachment.read must independently authorize it. */
function readImageSource(part: AnyToolPart): string | undefined {
  if (toolNameOf(part) !== "Read" || part.state !== "output-available") return undefined;
  const output = part.output;
  const fields =
    typeof output === "object" && output !== null ? (output as Record<string, unknown>) : undefined;
  const image = fields?.["type"] === "image";
  const viewedFile =
    part.type === "dynamic-tool" &&
    part.providerExecuted === true &&
    fields !== undefined &&
    Object.keys(fields).length === 0;
  if (!image && !viewedFile) return undefined;
  const input = part.input as Record<string, unknown> | undefined;
  const path =
    image && typeof fields?.["path"] === "string" ? fields["path"] : input?.["file_path"];
  if (typeof path !== "string" || !/^(\/|[A-Za-z]:[\\/])/.test(path)) return undefined;
  if (viewedFile && !/\.(png|jpe?g|gif|webp|svg)$/i.test(path)) return undefined;
  return path;
}

function ReadSourceImage({
  threadId,
  path,
  size,
}: {
  threadId: ThreadId;
  path: string;
  size: "thumbnail" | "large";
}) {
  const supported = /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
  const query = useAttachmentImage(threadId, path, supported);
  const src = imageDataUrl(query.data);
  if (src !== undefined)
    return (
      <AttachmentLightbox
        src={src}
        name={basename(path)}
        description={`Open ${basename(path)} at full size. Preview of the current attached source; the provider supplied a path.`}
        thumbnailClassName={size === "thumbnail" ? "max-h-24" : "max-h-96"}
      />
    );
  if (supported && query.status === "pending")
    return <span className="text-xs text-muted-foreground">Loading image preview…</span>;
  return (
    <Hint
      label="Previews require an available image already attached to this thread. The provider's source details remain in the tool card."
      render={
        <span
          tabIndex={0}
          data-testid="tool-image-missing"
          className="text-xs text-muted-foreground"
        />
      }
    >
      {query.data?.tooLarge
        ? "Image is too large to preview."
        : "Image preview unavailable: source is unsupported, missing or not attached to this thread."}
    </Hint>
  );
}

/** Same 5 MiB preview bound as attachment.read; size checked before scanning/decoding inline bytes. */
const INLINE_MAX_BYTES = 5 * 1024 * 1024;
function HistoricalToolImage({
  image,
  name,
  size,
}: {
  image: InlineToolImage;
  name: string;
  size: "thumbnail" | "large";
}) {
  const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((image.data.length * 3) / 4) - padding;
  const supported = /^(image\/(png|jpe?g|gif|webp|svg\+xml))$/i.test(image.mediaType);
  if (
    !supported ||
    bytes <= 0 ||
    bytes > INLINE_MAX_BYTES ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
  ) {
    return (
      <span data-testid="tool-image-missing" className="text-xs text-muted-foreground">
        Image preview unavailable: saved inline image is unsupported, invalid or too large.
      </span>
    );
  }
  return (
    <AttachmentLightbox
      src={`data:${image.mediaType};base64,${image.data}`}
      name={name}
      thumbnailClassName={size === "thumbnail" ? "max-h-24" : "max-h-96"}
    />
  );
}

function ToolImage({
  threadId,
  image,
  name,
  size,
}: {
  threadId: ThreadId;
  image: ToolImageData;
  name: string;
  size: "thumbnail" | "large";
}) {
  const query = useAttachmentImage(threadId, image.path ?? "", image.path !== undefined);
  const src = imageDataUrl(query.data);
  if (src !== undefined) {
    return (
      <AttachmentLightbox
        src={src}
        name={name}
        thumbnailClassName={size === "thumbnail" ? "max-h-24" : "max-h-96"}
      />
    );
  }
  if (image.path !== undefined && query.status === "pending") {
    return <span aria-hidden className="block size-16 animate-pulse rounded-md bg-muted" />;
  }
  return (
    <span
      data-testid="tool-image-missing"
      className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"
    >
      <ImageOff aria-hidden className="size-3.5" />
      {missingToolImageLabel(image, image.path === undefined ? "unstored" : "gone")}
    </span>
  );
}

/**
 * A tool call's images: a strip of thumbnails under its collapsed row, and the same images larger
 * in its opened body. Either opens full size on a click. Renders nothing for a call without any.
 */
export function ToolImages({
  part,
  size,
  className,
}: {
  part: AnyToolPart;
  size: "thumbnail" | "large";
  className?: string;
}) {
  const context = use(ToolImagesContext);
  const images = context?.byCall.get(part.toolCallId);
  if (context === null) return null;
  if (images === undefined) {
    const historical =
      part.state === "output-available" ? splitToolImageOutput(part.output).images : [];
    if (historical.length > 0)
      return (
        <ul data-testid="tool-images" data-size={size} className={className}>
          {historical.map((image, index) => (
            <li key={index} className="max-w-full">
              <HistoricalToolImage
                image={image}
                name={toolImageName(part, index, historical.length)}
                size={size}
              />
            </li>
          ))}
        </ul>
      );
    const source = readImageSource(part);
    return source === undefined ? null : (
      <div data-testid="tool-images" data-size={size} className={className}>
        <ReadSourceImage threadId={context.threadId} path={source} size={size} />
      </div>
    );
  }
  return (
    <ul data-testid="tool-images" data-size={size} className={className}>
      {images.map((image, i) => (
        <li key={image.path ?? i} className="max-w-full">
          <ToolImage
            threadId={context.threadId}
            image={image}
            name={toolImageName(part, i, images.length)}
            size={size}
          />
        </li>
      ))}
    </ul>
  );
}
