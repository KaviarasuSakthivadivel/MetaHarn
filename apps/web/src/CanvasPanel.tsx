import Markdown, { type CanvasPayload } from "./Markdown.js";

export default function CanvasPanel({ payload, onClose }: { payload: CanvasPayload; onClose: () => void }) {
  const fence = "```" + (payload.language || "") + "\n" + payload.content + "\n```";
  return (
    <div className="canvas-panel">
      <div className="canvas-header">
        <div>
          <div className="canvas-title">{payload.title}</div>
          <div className="canvas-sub">{payload.content.split("\n").length} lines</div>
        </div>
        <button className="btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="canvas-body">
        <Markdown>{fence}</Markdown>
      </div>
    </div>
  );
}
