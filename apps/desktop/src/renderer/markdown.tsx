import type { ReactNode } from "react";

/**
 * A minimal, non-CommonMark markdown renderer for assistant chat text —
 * fenced code blocks, inline code, bold, and lists. MetaHarn's whole premise
 * is embedding real coding-agent CLIs; their responses are dominated by
 * code snippets, so rendering that as flat whiteSpace:pre-wrap text with
 * visible fence/backtick/asterisk characters was the single biggest
 * scannability loss in the chat transcript. Deliberately not a full parser
 * (no tables, headers, blockquotes, nested lists) — just the constructs
 * that actually show up constantly in agent output.
 */
export function renderMarkdown(text: string, keyPrefix: string): ReactNode {
  const blocks = splitCodeBlocks(text);
  return (
    <>
      {blocks.map((block, i) =>
        block.type === "code" ? (
          <pre
            key={`${keyPrefix}-code-${i}`}
            style={{
              background: "var(--color-bg-secondary)",
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              padding: "10px 12px",
              overflowX: "auto",
              fontSize: 12.5,
              fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
              margin: "6px 0",
            }}
          >
            <code>{block.text}</code>
          </pre>
        ) : (
          <div key={`${keyPrefix}-text-${i}`}>{renderTextBlock(block.text, `${keyPrefix}-${i}`)}</div>
        ),
      )}
    </>
  );
}

interface Block {
  type: "code" | "text";
  text: string;
  lang?: string;
}

const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

function splitCodeBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((match = FENCE_RE.exec(text))) {
    if (match.index > lastIndex) blocks.push({ type: "text", text: text.slice(lastIndex, match.index) });
    blocks.push({ type: "code", lang: match[1].trim(), text: match[2].replace(/\n$/, "") });
    lastIndex = FENCE_RE.lastIndex;
  }
  if (lastIndex < text.length) blocks.push({ type: "text", text: text.slice(lastIndex) });
  return blocks.length ? blocks : [{ type: "text", text }];
}

const LIST_ITEM_RE = /^\s*(?:[-*]|\d+\.)\s+(.*)$/;

function renderTextBlock(text: string, keyPrefix: string): ReactNode {
  const lines = text.split("\n");
  const nodes: ReactNode[] = [];
  let listBuffer: string[] = [];
  let listKey = 0;

  const flushList = () => {
    if (!listBuffer.length) return;
    nodes.push(
      <ul key={`${keyPrefix}-list-${listKey++}`} style={{ margin: "4px 0", paddingLeft: 20 }}>
        {listBuffer.map((item, i) => (
          <li key={i} style={{ margin: "2px 0" }}>
            {renderInline(item, `${keyPrefix}-li-${listKey}-${i}`)}
          </li>
        ))}
      </ul>,
    );
    listBuffer = [];
  };

  lines.forEach((line, i) => {
    const listMatch = line.match(LIST_ITEM_RE);
    if (listMatch) {
      listBuffer.push(listMatch[1]);
      return;
    }
    flushList();
    if (line.trim() === "") {
      if (i !== lines.length - 1) nodes.push(<br key={`${keyPrefix}-br-${i}`} />);
      return;
    }
    nodes.push(
      <span key={`${keyPrefix}-line-${i}`} style={{ display: "block" }}>
        {renderInline(line, `${keyPrefix}-inline-${i}`)}
      </span>,
    );
  });
  flushList();

  return nodes;
}

const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*)/g;

function renderInline(text: string, keyPrefix: string): ReactNode {
  const parts = text.split(INLINE_RE);
  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return (
        <code
          key={`${keyPrefix}-${i}`}
          style={{
            background: "var(--color-bg-secondary)",
            border: "1px solid var(--color-border)",
            borderRadius: 4,
            padding: "1px 5px",
            fontSize: "0.92em",
            fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace',
          }}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) {
      return <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>;
    }
    return part ? <span key={`${keyPrefix}-${i}`}>{part}</span> : null;
  });
}
