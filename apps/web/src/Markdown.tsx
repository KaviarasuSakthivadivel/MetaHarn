import { isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

export interface CanvasPayload {
  title: string;
  language: string;
  content: string;
}

/** Pulls the plain text back out of a rendered children tree — needed because
 * rehype-highlight has already wrapped code tokens in <span class="hljs-..."> elements by
 * the time our `pre`/`code` overrides see `children`, so a raw `String(children)` would
 * stringify React elements instead of the source text the copy/Canvas actions need. */
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
      className="code-block-action"
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

const CANVAS_LINE_THRESHOLD = 8;

function makeComponents(onOpenCanvas?: (payload: CanvasPayload) => void): Components {
  return {
    a({ href, children }) {
      return (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      );
    },
    img({ src, alt }) {
      if (!src || typeof src !== "string") return null;
      return <img src={src} alt={alt ?? ""} className="md-image" loading="lazy" />;
    },
    code({ className, children, ...props }) {
      const isBlock = /(^|\s)(language-|hljs)/.test(className ?? "");
      if (!isBlock) {
        return (
          <code className="inline-code" {...props}>
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
      const lineCount = raw.split("\n").length;
      return (
        <div className="code-block">
          <div className="code-block-header">
            <span className="code-block-lang">{language || "text"}</span>
            <div className="code-block-actions">
              <CopyButton text={raw} />
              {onOpenCanvas && lineCount > CANVAS_LINE_THRESHOLD && (
                <button className="code-block-action" onClick={() => onOpenCanvas({ title: language ? `${language} snippet` : "Snippet", language, content: raw })}>
                  Open in Canvas
                </button>
              )}
            </div>
          </div>
          <pre {...props}>{children}</pre>
        </div>
      );
    },
  };
}

export default function Markdown({ children, onOpenCanvas }: { children: string; onOpenCanvas?: (payload: CanvasPayload) => void }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={makeComponents(onOpenCanvas)}>
      {children}
    </ReactMarkdown>
  );
}
