"use client";

import { Button } from "@/components/ui/button";

import { cn } from "@/lib/utils";
import { Swap } from "@/motion";
import { CheckIcon, CopyIcon } from "lucide-react";
import type { ComponentProps, CSSProperties, HTMLAttributes } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BundledLanguage, ThemedToken } from "shiki";

import { createRawTokens, highlightCode, type TokenizedCode } from "@/lib/code-highlighting";

export { highlightCode } from "@/lib/code-highlighting";

// Shiki uses bitflags for font styles: 1=italic, 2=bold, 4=underline
// oxlint-disable-next-line eslint(no-bitwise)
const isItalic = (fontStyle: number | undefined) => fontStyle && fontStyle & 1;
// oxlint-disable-next-line eslint(no-bitwise)
const isBold = (fontStyle: number | undefined) => fontStyle && fontStyle & 2;
const isUnderline = (fontStyle: number | undefined) =>
  // oxlint-disable-next-line eslint(no-bitwise)
  fontStyle && fontStyle & 4;

// Transform tokens to include pre-computed keys to avoid noArrayIndexKey lint
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

// Token rendering component
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

// Line number styles using CSS counters
const LINE_NUMBER_CLASSES = cn(
  "block",
  "before:content-[counter(line)]",
  "before:inline-block",
  "before:[counter-increment:line]",
  "before:w-8",
  "before:mr-4",
  "before:text-right",
  "before:text-muted-foreground/50",
  "before:font-mono",
  "before:select-none",
);

// Line rendering component
const LineSpan = ({
  keyedLine,
  number,
  showLineNumbers,
  highlighted,
}: {
  keyedLine: KeyedLine;
  /** 1-based. */
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

// Types
type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: BundledLanguage;
  showLineNumbers?: boolean;
};

interface CodeBlockContextType {
  code: string;
}

// Context
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
          "dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)] m-0 p-4 text-sm",
          className,
        )}
        style={preStyle}
      >
        <code
          className={cn(
            "font-mono text-sm",
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
}) => {
  const tokenized = useCodeTokens(code, language, enabled);
  // Shiki consumes CRLF separators. Use the source separators, and never display altered text
  // if a grammar's tokens cannot round-trip the source (including the initial raw fallback).
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
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<number>(0);
  const { code } = useContext(CodeBlockContext);

  const copyToClipboard = useCallback(async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      if (!isCopied) {
        await navigator.clipboard.writeText(code);
        setIsCopied(true);
        onCopy?.();
        timeoutRef.current = window.setTimeout(() => setIsCopied(false), timeout);
      }
    } catch (error) {
      onError?.(error as Error);
    }
  }, [code, onCopy, onError, timeout, isCopied]);

  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    [],
  );

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
