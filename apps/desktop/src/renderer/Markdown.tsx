import { isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

/**
 * Full CommonMark + GFM rendering for assistant chat text (headings, tables, blockquotes,
 * nested lists, syntax-highlighted fenced code) — ported from apps/web/src/Markdown.tsx, which
 * already solved this for the web surface. Replaces this file's former hand-rolled renderer
 * (markdown.tsx), which admitted in its own doc comment it didn't handle headings or tables —
 * exactly the constructs real agent replies (`## Summary`, a `| col | col |` table) use and which
 * were showing up as literal raw text in the UI.
 *
 * Unlike web, desktop has no Canvas panel, so there's no "Open in Canvas" button here — just the
 * language label + Copy button on fenced code blocks. Styling is in theme.css (search for
 * ".metaharn-msg-text"): every color is a `var(--color-*)` theme token (no hardcoded hex) so
 * this renders correctly across every theme in themes.ts, not just one fixed light/dark pair
 * the way web's CSS is.
 */
function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) return extractText((node.props as { children?: ReactNode }).children);
  return "";
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="metaharn-code-block-action"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

const components: Components = {
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  img({ src, alt }) {
    if (!src || typeof src !== "string") return null;
    return <img src={src} alt={alt ?? ""} className="metaharn-md-image" loading="lazy" />;
  },
  code({ className, children, ...props }) {
    const isBlock = /(^|\s)(language-|hljs)/.test(className ?? "");
    if (!isBlock) {
      return (
        <code className="metaharn-inline-code" {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  pre({ children, ...props }) {
    const raw = extractText(children).replace(/\n$/, "");
    const firstChild = Array.isArray(children) ? children[0] : children;
    const childClassName = isValidElement(firstChild) ? (firstChild.props as { className?: string }).className : undefined;
    const language = /language-(\w+)/.exec(childClassName ?? "")?.[1] ?? "";
    return (
      <div className="metaharn-code-block">
        <div className="metaharn-code-block-header">
          <span className="metaharn-code-block-lang">{language || "text"}</span>
          <div className="metaharn-code-block-actions">
            <CopyButton text={raw} />
          </div>
        </div>
        <pre {...props}>{children}</pre>
      </div>
    );
  },
};

export default function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
      {children}
    </ReactMarkdown>
  );
}
