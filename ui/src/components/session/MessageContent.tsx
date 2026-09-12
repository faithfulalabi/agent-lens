import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Transcript prose cannot execute HTML or load external images. */
export function MessageContent({ text }: { text: string }) {
  return (
    <div className="message-markdown break-words">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ alt }) => <span className="text-muted">[Image: {alt || 'attachment'}]</span>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
