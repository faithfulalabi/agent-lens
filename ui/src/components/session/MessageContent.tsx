import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Node = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: object;
  children?: Node[];
};

/** Raw HTML would print as escaped text anyway; this keeps its line breaks. */
function rawKeepsBreaks() {
  const visit = (node: Node) => {
    node.children?.forEach((child, i, siblings) => {
      if (child.type !== 'raw') return visit(child);
      siblings[i] = {
        type: 'element',
        tagName: 'span',
        properties: { className: ['whitespace-pre-wrap'] },
        children: [{ type: 'text', value: child.value }],
      };
    });
  };
  return visit;
}

/** Transcript prose cannot execute HTML or load external images. */
export function MessageContent({ text }: { text: string }) {
  // An HTML block runs to the next blank line, so a wrapper tag would swallow the markdown inside it.
  const unwrapped = text.replace(/^(<[\w-]+>)\n/, '$1\n\n').replace(/\n(<\/[\w-]+>)$/, '\n\n$1');
  return (
    <div className="message-markdown break-words">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rawKeepsBreaks]}
        components={{
          p: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
          img: ({ alt }) => <span className="text-muted">[Image: {alt || 'attachment'}]</span>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {unwrapped}
      </Markdown>
    </div>
  );
}
