// `gram/link-not-button`: see the header of `gram.mjs`.

const named = (name, wanted) => name.type === "JSXIdentifier" && name.name === wanted;

export const linkNotButton = {
  meta: {
    type: "problem",
    docs: {
      description: "Style a link as a button with buttonVariants, so it stays a link",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (!named(node.name, "Button")) return;
        for (const attribute of node.attributes) {
          if (attribute.type !== "JSXAttribute" || attribute.name.name !== "render") continue;
          const value = attribute.value;
          if (
            value?.type === "JSXExpressionContainer" &&
            value.expression.type === "JSXElement" &&
            named(value.expression.openingElement.name, "Link")
          )
            context.report({
              node: attribute,
              message:
                'A `Button` that renders a `Link` gives `<a href role="button">`, which a screen reader announces as a button though it navigates. Render the `Link` itself with `className={cn(buttonVariants({ variant, size }))}` (cn lets the size classes win over the base ones, as in `Button`) and `data-slot="button"`.',
            });
        }
      },
    };
  },
};
