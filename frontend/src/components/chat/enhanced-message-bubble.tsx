import { type ReactNode, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";
import { BrainCircuit, FileText, Image } from "lucide-react";
import { ChatMessage } from "@/types/api";

interface EnhancedMessageBubbleProps {
  message: ChatMessage;
}

function attachmentIcon(mimeType: string) {
  return mimeType.startsWith("image/") ? Image : FileText;
}

type MarkdownChildrenProps = {
  children?: ReactNode;
};

type MarkdownCodeProps = MarkdownChildrenProps & {
  className?: string;
};

export function MarkdownText({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }: MarkdownChildrenProps) => <h1 className="mb-3 mt-5 text-2xl font-semibold leading-8 text-milk">{children}</h1>,
        h2: ({ children }: MarkdownChildrenProps) => <h2 className="mb-3 mt-5 text-xl font-semibold leading-7 text-milk">{children}</h2>,
        h3: ({ children }: MarkdownChildrenProps) => <h3 className="mb-2 mt-4 text-lg font-semibold leading-7 text-milk">{children}</h3>,
        h4: ({ children }: MarkdownChildrenProps) => <h4 className="mb-2 mt-4 text-base font-semibold leading-6 text-milk">{children}</h4>,
        p: ({ children }: MarkdownChildrenProps) => <p className="my-2 whitespace-pre-wrap text-sm leading-7 text-milk/84">{children}</p>,
        ul: ({ children }: MarkdownChildrenProps) => <ul className="my-3 list-disc space-y-1.5 pl-5 text-sm leading-7 text-milk/82">{children}</ul>,
        ol: ({ children }: MarkdownChildrenProps) => <ol className="my-3 list-decimal space-y-1.5 pl-5 text-sm leading-7 text-milk/82">{children}</ol>,
        li: ({ children }: MarkdownChildrenProps) => <li className="pl-1">{children}</li>,
        hr: () => <hr className="my-5 border-line/55" />,
        strong: ({ children }: MarkdownChildrenProps) => <strong className="font-semibold text-milk">{children}</strong>,
        em: ({ children }: MarkdownChildrenProps) => <em className="text-milk/82">{children}</em>,
        blockquote: ({ children }: MarkdownChildrenProps) => (
          <blockquote className="my-3 border-l-2 border-accent/45 bg-panel/30 py-2 pl-4 text-milk/70">{children}</blockquote>
        ),
        pre: ({ children }: MarkdownChildrenProps) => (
          <pre className="my-3 max-h-96 overflow-auto rounded-2xl border border-line/60 bg-shell/60 px-4 py-3 text-xs leading-6 text-milk/76">
            {children}
          </pre>
        ),
        code: ({ className, children }: MarkdownCodeProps) => {
          const isBlock = Boolean(className);
          if (isBlock) {
            return <code className={cn(className, "font-mono")}>{children}</code>;
          }
          return <code className="rounded bg-panel px-1.5 py-0.5 font-mono text-[0.92em] text-accent">{children}</code>;
        },
        table: ({ children }: MarkdownChildrenProps) => (
          <div className="my-3 overflow-x-auto rounded-2xl border border-line/55">
            <table className="w-full border-collapse text-sm text-milk/78">{children}</table>
          </div>
        ),
        th: ({ children }: MarkdownChildrenProps) => <th className="border-b border-line bg-panel/60 px-3 py-2 text-left font-semibold text-milk">{children}</th>,
        td: ({ children }: MarkdownChildrenProps) => <td className="border-b border-line/45 px-3 py-2 align-top">{children}</td>,
        a: ({ children, href }: MarkdownChildrenProps & { href?: string }) => (
          <a href={href} target="_blank" rel="noreferrer" className="text-accent underline decoration-accent/45 underline-offset-4">
            {children}
          </a>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function formatThoughtTime(ms?: number | null) {
  if (!ms || !Number.isFinite(ms)) {
    return "Thought";
  }
  if (ms < 1000) {
    return `Thought for ${(ms / 1000).toFixed(1)}s`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `Thought for ${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `Thought for ${minutes}m ${rest}s`;
}

export function EnhancedMessageBubble({ message }: EnhancedMessageBubbleProps) {
  const isUser = message.role === 'user';
  const [showThinking, setShowThinking] = useState(false);
  
  return (
    <div className={cn(
      "flex w-full", 
      isUser ? "justify-end" : "justify-start",
      "animate-in slide-in-from-bottom-2 duration-200"
    )}>
      <div className={cn(
        "max-w-[min(860px,100%)] transition-all",
        isUser 
          ? "ml-auto rounded-[24px] bg-milk/10 px-4 py-3 text-left text-milk/88 shadow-[inset_0_0_0_1px_rgb(var(--color-line)/0.42)]" 
          : "w-full"
      )}>
        {isUser ? null : (
          <div className="mb-2 flex items-center gap-2 text-xs text-milk/42">
            <span>{formatThoughtTime(message.thinkingMs)}</span>
            {message.thinkingTokens ? <span>{message.thinkingTokens} thinking tokens</span> : null}
            {message.thinkingContent ? (
              <button
                type="button"
                onClick={() => setShowThinking((value) => !value)}
                className="rounded-full border border-line/45 px-2 py-0.5 text-[11px] text-milk/48 hover:text-milk"
              >
                {showThinking ? "Hide thoughts" : "Show thoughts"}
              </button>
            ) : null}
          </div>
        )}
        
        {!isUser && message.thinkingContent && showThinking ? (
          <div className="mb-3 max-h-64 overflow-y-auto border-l border-accent/30 pl-4">
            <div className="flex items-center gap-2 text-xs font-medium text-accent">
              <BrainCircuit className="h-3.5 w-3.5" />
              <span>Thinking</span>
              {message.thinkingTokens && (
                <span className="text-xs text-milk/38">{message.thinkingTokens} tokens</span>
              )}
            </div>
            <div className="mt-2 border-l-2 border-accent/30 pl-3 text-sm text-milk/58">
              <p className="whitespace-pre-wrap">{message.thinkingContent}</p>
            </div>
          </div>
        ) : null}
        
        <div className={cn(!isUser && "border-l border-accent/35 pl-4")}>
          {isUser ? <p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p> : <MarkdownText content={message.content} />}
        </div>
        
        {message.truncated && (
          <div className="mt-3 rounded-2xl border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning">
            Answer stopped at {message.maxTokens ?? "the"} token limit. The model did not crash; ask it to continue or raise the chat token limit later in Settings.
          </div>
        )}
        
        {message.attachments && message.attachments.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {message.attachments.map((attachment, idx) => {
              const IconComponent = attachmentIcon(attachment.mime_type);
              return (
                <span 
                  key={idx} 
                  className="inline-flex items-center gap-2 rounded-full border border-accent/28 bg-accent/12 px-3 py-1 text-xs text-milk/78"
                >
                  <IconComponent className="h-3.5 w-3.5 text-accent" />
                  {attachment.name}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
