import { Fragment, useMemo } from 'react';
import { parseReply, type Inline } from './replyFormat';

function Text({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.bold ? (
          <strong key={index} className="font-semibold">
            {part.text}
          </strong>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

/** An assistant reply as paragraphs, headings and lists. Text only: no HTML is ever injected. */
export function FormattedReply({ text }: { text: string }) {
  const blocks = useMemo(() => parseReply(text), [text]);
  return (
    <div className="space-y-2">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'heading':
            return (
              <p key={index} className="font-semibold text-sage-900">
                <Text parts={block.text} />
              </p>
            );
          case 'bullets':
            return (
              <ul key={index} className="list-disc space-y-1 pl-5">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <Text parts={item} />
                  </li>
                ))}
              </ul>
            );
          case 'numbered':
            return (
              <ol key={index} start={block.start} className="list-decimal space-y-1 pl-5">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <Text parts={item} />
                  </li>
                ))}
              </ol>
            );
          default:
            return (
              <p key={index}>
                {block.lines.map((line, lineIndex) => (
                  <Fragment key={lineIndex}>
                    {lineIndex > 0 && <br />}
                    <Text parts={line} />
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
