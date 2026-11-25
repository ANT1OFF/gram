interface HastText {
  type: "text";
  value: string;
}

interface HastElement {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}

type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };

const isElement = (node: HastNode): node is HastElement => node.type === "element";

const LOADING = ["src", "srcSet", "poster", "data", "background", "imageSrcSet", "href"] as const;
const LOADS_HREF = new Set(["link", "image", "use", "feImage"]);
const CANDIDATES = new Set(["srcSet", "imageSrcSet"]);

const LOCAL_SCHEME = /^(data|blob):/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Whether `url` names another origin: it has a scheme the network serves, or starts with two
 * slashes (either way round, which browsers read alike). A relative path stays the page's own,
 * and the components that render it decide what it means.
 */
export const isRemoteUrl = (url: string): boolean => {
  const trimmed = [...url].filter((char) => char.charCodeAt(0) > 0x20).join("");
  if (/^[\\/]{2}/.test(trimmed)) return true;
  return SCHEME.test(trimmed) && !LOCAL_SCHEME.test(trimmed);
};

const candidatesRemote = (value: string): boolean =>
  value.split(",").some((candidate) => {
    const url = candidate.trim().split(/\s+/)[0] ?? "";
    return url !== "" && isRemoteUrl(url);
  });

const remote = (name: string, value: unknown): boolean => {
  const values = Array.isArray(value) ? value : [value];
  return values.some(
    (one) =>
      typeof one === "string" && (CANDIDATES.has(name) ? candidatesRemote(one) : isRemoteUrl(one)),
  );
};

const inertImage = (element: HastElement): HastElement => {
  const src = element.properties?.["src"];
  const alt = element.properties?.["alt"];
  return {
    type: "element",
    tagName: "span",
    properties: {
      className: ["text-muted-foreground"],
      dataRemoteImage: "",
      ...(typeof src === "string" ? { title: src } : {}),
    },
    children: [
      { type: "text", value: `[${typeof alt === "string" && alt !== "" ? alt : "image"}]` },
    ],
  };
};

const tame = (element: HastElement): HastNode | undefined => {
  const properties = element.properties ?? {};
  const loads = LOADING.filter(
    (name) =>
      name in properties &&
      (name !== "href" || LOADS_HREF.has(element.tagName)) &&
      remote(name, properties[name]),
  );
  if (loads.length === 0) return element;
  if (element.tagName === "img") return inertImage(element);
  if (element.tagName === "source") return undefined;
  const kept = { ...properties };
  for (const name of loads) delete kept[name];
  return { ...element, properties: kept };
};

const visit = (node: HastNode): void => {
  if (!("children" in node) || node.children === undefined) return;
  const next: HastNode[] = [];
  for (const child of node.children) {
    if (!isElement(child)) {
      next.push(child);
      continue;
    }
    const tamed = tame(child);
    if (tamed === undefined) continue;
    visit(tamed);
    next.push(tamed);
  }
  node.children = next;
};

/** The rehype plugin: no element in the tree loads another origin as it renders. */
export const rehypeNoRemoteResources = () => (tree: HastNode) => visit(tree);
