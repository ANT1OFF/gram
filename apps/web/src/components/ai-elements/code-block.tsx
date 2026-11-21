"use client";

import { Button } from "@/components/ui/button";

import { cn } from "@/lib/utils";
import { Swap } from "@/motion";
import { CheckIcon, CopyIcon } from "lucide-react";
import type { ComponentProps, CSSProperties, HTMLAttributes } from "react";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { BundledLanguage, ThemedToken } from "shiki";

import {
  canHighlightCode,
  createRawTokens,
  highlightCode,
  type TokenizedCode,
} from "@/lib/code-highlighting";
import { paintEmbedded } from "@/lib/command-tokens";
import { embeddedScripts, type EmbeddedScript } from "@/lib/embedded-scripts";
import { useFlash } from "@/lib/timers";

export { highlightCode } from "@/lib/code-highlighting";

const isItalic = (fontStyle: number | undefined) => fontStyle && fontStyle & 1;
const isBold = (fontStyle: number | undefined) => fontStyle && fontStyle & 2;
const isUnderline = (fontStyle: number | undefined) => fontStyle && fontStyle & 4;

interface KeyedToken {
  token: ThemedToken;
  key: string;
}
interface KeyedLine {
  tokens: KeyedToken[];
  key: string;
}

const addKeysToTokens = (lines: ThemedToken[][]): KeyedLine[] =>
  lines.map((line, lineIdx) => ({
    key: `line-${lineIdx}`,
    tokens: line.map((token, tokenIdx) => ({
      key: `line-${lineIdx}-${tokenIdx}`,
      token,
    })),
  }));

export const TokenSpan = ({ token }: { token: ThemedToken }) => (
  <span
    className="dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)]"
    style={
      {
        backgroundColor: token.bgColor,
        color: token.color,
        fontStyle: isItalic(token.fontStyle) ? "italic" : undefined,
        fontWeight: isBold(token.fontStyle) ? "bold" : undefined,
        textDecoration: isUnderline(token.fontStyle) ? "underline" : undefined,
        ...token.htmlStyle,
      } as CSSProperties
    }
  >
    {token.content}
  </span>
);

const LINE_NUMBER_CLASSES = cn(
  "block",
  "before:content-[counter(line)]",
  "before:inline-block",
  "before:[counter-increment:line]",
  "before:w-8",
  "before:mr-4",
  "before:text-right",
  "before:text-subtle",
  "before:font-mono",
  "before:select-none",
);

const LineSpan = ({
  keyedLine,
  number,
  showLineNumbers,
  highlighted,
}: {
  keyedLine: KeyedLine;
  number: number;
  showLineNumbers: boolean;
  highlighted: boolean;
}) => (
  <span
    data-line={number}
    data-highlighted={highlighted ? "" : undefined}
    className={cn(showLineNumbers ? LINE_NUMBER_CLASSES : "block", highlighted && "bg-primary/15")}
  >
    {keyedLine.tokens.length === 0
      ? "\n"
      : keyedLine.tokens.map(({ token, key }) => <TokenSpan key={key} token={token} />)}
  </span>
);

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: BundledLanguage;
  showLineNumbers?: boolean;
};

interface CodeBlockContextType {
  code: string;
}

const CodeBlockContext = createContext<CodeBlockContextType>({
  code: "",
});

const CodeBlockBody = memo(
  ({
    tokenized,
    showLineNumbers,
    highlightLine,
    highlightEnd,
    className,
  }: {
    tokenized: TokenizedCode;
    showLineNumbers: boolean;
    highlightLine?: number | undefined;
    highlightEnd?: number | undefined;
    className?: string;
  }) => {
    const preStyle = useMemo(
      () => ({
        backgroundColor: tokenized.bg,
        color: tokenized.fg,
      }),
      [tokenized.bg, tokenized.fg],
    );

    const keyedLines = useMemo(() => addKeysToTokens(tokenized.tokens), [tokenized.tokens]);

    return (
      <pre
        className={cn(
          "dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)] m-0 p-4 text-reading phone:whitespace-pre-wrap phone:[overflow-wrap:anywhere]",
          className,
        )}
        style={preStyle}
      >
        <code
          className={cn(
            "font-mono text-reading",
            showLineNumbers && "[counter-increment:line_0] [counter-reset:line]",
          )}
        >
          {keyedLines.map((keyedLine, index) => (
            <LineSpan
              key={keyedLine.key}
              keyedLine={keyedLine}
              number={index + 1}
              showLineNumbers={showLineNumbers}
              highlighted={
                highlightLine !== undefined &&
                index + 1 >= highlightLine &&
                index + 1 <= (highlightEnd ?? highlightLine)
              }
            />
          ))}
        </code>
      </pre>
    );
  },
  (prevProps, nextProps) =>
    prevProps.tokenized === nextProps.tokenized &&
    prevProps.showLineNumbers === nextProps.showLineNumbers &&
    prevProps.highlightLine === nextProps.highlightLine &&
    prevProps.highlightEnd === nextProps.highlightEnd &&
    prevProps.className === nextProps.className,
);

CodeBlockBody.displayName = "CodeBlockBody";

const CodeBlockContainer = ({
  className,
  language,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { language: string }) => (
  <div
    className={cn(
      "group relative w-full overflow-hidden rounded-md border bg-background text-foreground",
      className,
    )}
    data-language={language}
    style={{
      containIntrinsicSize: "auto 200px",
      contentVisibility: "auto",
      ...style,
    }}
    {...props}
  />
);

/** Plain text is visible immediately; stale async results never replace newer input. */
export const useCodeTokens = (code: string, language: BundledLanguage, enabled = true) => {
  const rawTokens = useMemo(() => createRawTokens(code), [code]);
  const [result, setResult] = useState<{
    code: string;
    language: BundledLanguage;
    tokens: TokenizedCode;
  }>();

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const receive = (tokens: TokenizedCode) => {
      if (!cancelled) setResult({ code, language, tokens });
    };
    const cached = highlightCode(code, language, receive);
    if (cached) receive(cached);
    return () => {
      cancelled = true;
    };
  }, [code, language, enabled]);

  return enabled && result?.code === code && result.language === language
    ? result.tokens
    : rawTokens;
};

/** Inline tokens preserve the exact source, including blank lines and trailing newlines. */
export const HighlightedCode = ({
  code,
  language,
  enabled = true,
}: {
  code: string;
  language: BundledLanguage;
  enabled?: boolean;
}) => (
  <InlineTokens
    code={code}
    language={language}
    tokenized={useCodeTokens(code, language, enabled)}
  />
);

/**
 * A shell command's tokens, with each program inside it in its own language once both have
 * loaded: the Python of a `python3 - <<'PY'` here-doc, the shell inside `zsh -lc "…"`.
 */
export const useCommandTokens = (code: string, enabled = true) => {
  const outer = useCodeTokens(code, "shellscript", enabled);
  const scripts = useMemo(
    () => (enabled && canHighlightCode(code) ? embeddedScripts(code) : []),
    [code, enabled],
  );
  const [layers, setLayers] = useState<{
    scripts: EmbeddedScript[];
    tokens: (TokenizedCode | undefined)[];
  }>();

  useEffect(() => {
    if (scripts.length === 0) return;
    let cancelled = false;
    const tokens = Array.from<TokenizedCode | undefined>({ length: scripts.length });
    for (const [index, script] of scripts.entries()) {
      const receive = (result: TokenizedCode) => {
        if (cancelled) return;
        tokens[index] = result;
        setLayers({ scripts, tokens: [...tokens] });
      };
      const cached = highlightCode(script.text, script.language as BundledLanguage, receive);
      if (cached) receive(cached);
    }
    return () => {
      cancelled = true;
    };
  }, [scripts]);

  return useMemo(() => {
    if (!enabled || outer.fg === "inherit" || layers?.scripts !== scripts) return outer;
    const ready = scripts.flatMap((script, index) => {
      const tokens = layers.tokens[index];
      return tokens ? [{ script, tokens }] : [];
    });
    return paintEmbedded(code, outer, ready);
  }, [code, enabled, outer, scripts, layers]);
};

/** A shell command, coloured as `useCommandTokens` reads it; the text is exactly `code`. */
export const HighlightedCommand = ({
  code,
  enabled = true,
}: {
  code: string;
  enabled?: boolean;
}) => (
  <InlineTokens code={code} language="shellscript" tokenized={useCommandTokens(code, enabled)} />
);

const InlineTokens = ({
  code,
  language,
  tokenized,
}: {
  code: string;
  language: string;
  tokenized: TokenizedCode;
}) => {
  const separators = useMemo(() => code.match(/\r?\n/gu) ?? [], [code]);
  const preservesSource =
    tokenized.tokens.length === separators.length + 1 &&
    tokenized.tokens
      .map(
        (line, index) =>
          (index > 0 ? separators[index - 1] : "") + line.map((token) => token.content).join(""),
      )
      .join("") === code;
  return (
    <code data-language={language} className="font-mono">
      {preservesSource
        ? tokenized.tokens.map((line, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- positions belong to this source string
            <span key={index}>
              {index > 0 && separators[index - 1]}
              {line.map((token, tokenIndex) => (
                // oxlint-disable-next-line react/no-array-index-key -- positions belong to this source string
                <TokenSpan key={tokenIndex} token={token} />
              ))}
            </span>
          ))
        : code}
    </code>
  );
};

export const CodeBlockContent = ({
  code,
  language,
  showLineNumbers = false,
  highlightLine,
  highlightEnd,
}: {
  code: string;
  language: BundledLanguage;
  showLineNumbers?: boolean;
  /** A 1-based line to mark (`data-highlighted`), e.g. a search result's. */
  highlightLine?: number | undefined;
  /** With `highlightLine`, the last line of a marked range. */
  highlightEnd?: number | undefined;
}) => {
  const tokenized = useCodeTokens(code, language);

  return (
    <div className="relative overflow-auto">
      <CodeBlockBody
        showLineNumbers={showLineNumbers}
        highlightLine={highlightLine}
        highlightEnd={highlightEnd}
        tokenized={tokenized}
      />
    </div>
  );
};

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  const contextValue = useMemo(() => ({ code }), [code]);

  return (
    <CodeBlockContext.Provider value={contextValue}>
      <CodeBlockContainer className={className} language={language} {...props}>
        {children}
        <CodeBlockContent code={code} language={language} showLineNumbers={showLineNumbers} />
      </CodeBlockContainer>
    </CodeBlockContext.Provider>
  );
};

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  const [isCopied = false, flash] = useFlash(timeout);
  const { code } = useContext(CodeBlockContext);

  const copyToClipboard = useCallback(async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      if (!isCopied) {
        await navigator.clipboard.writeText(code);
        flash(true);
        onCopy?.();
      }
    } catch (error) {
      onError?.(error as Error);
    }
  }, [code, onCopy, onError, flash, isCopied]);

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      className={cn("shrink-0", className)}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? (
        <Swap swapKey={isCopied ? "copied" : "copy"}>
          <Icon size={14} />
        </Swap>
      )}
    </Button>
  );
};
