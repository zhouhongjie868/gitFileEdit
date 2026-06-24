import { diffLines } from "diff";
import { useMemo, type RefObject } from "react";
import { emptyBlockClass, cn } from "../lib/ui";

interface DiffLine {
  text: string;
  hasNewline: boolean;
}

interface DiffBlock {
  id: string;
  type: "added" | "removed" | "same";
  marker: "+" | "-" | " ";
  line: DiffLine;
  lineNumber: number;
  afterLineNumber: number | null;
}

export function DiffView(props: {
  before: string;
  after: string;
  emptyText: string;
  className?: string;
  showContentWhenUnchanged?: boolean;
  scrollRef?: RefObject<HTMLDivElement>;
  highlightAfterLine?: number | null;
}): JSX.Element {
  const diffBlocks = useMemo<DiffBlock[]>(() => {
    if (props.before === props.after) {
      return splitDiffLines(props.after).map((line, lineIndex): DiffBlock => ({
        id: `same-${lineIndex}`,
        type: "same",
        marker: " ",
        line,
        lineNumber: lineIndex + 1,
        afterLineNumber: lineIndex + 1
      }));
    }

    let beforeLineNumber = 1;
    let afterLineNumber = 1;
    const segments = diffLines(props.before, props.after);
    return segments.flatMap((segment, segmentIndex) => {
      const type = segment.added ? "added" : segment.removed ? "removed" : "same";
      const marker = segment.added ? "+" : segment.removed ? "-" : " ";
      const lines = splitDiffLines(segment.value);

      return lines.map((line, lineIndex): DiffBlock => {
        const lineNumber = type === "removed" ? beforeLineNumber : afterLineNumber;
        const nextAfterLineNumber = type === "removed" ? null : afterLineNumber;
        if (type === "added") {
          afterLineNumber += 1;
        } else if (type === "removed") {
          beforeLineNumber += 1;
        } else {
          beforeLineNumber += 1;
          afterLineNumber += 1;
        }

        return {
          id: `${segmentIndex}-${lineIndex}`,
          type,
          marker,
          line,
          lineNumber,
          afterLineNumber: nextAfterLineNumber
        };
      });
    });
  }, [props.before, props.after]);

  const hasChange = diffBlocks.some((block) => block.type !== "same");
  const blocks = hasChange || props.showContentWhenUnchanged
    ? diffBlocks
    : [];
  if (blocks.length === 0) {
    return <div ref={props.scrollRef} className={cn(emptyBlockClass, props.className)}>{props.emptyText}</div>;
  }

  return (
    <div ref={props.scrollRef} className={cn("grid auto-rows-min content-start gap-0.5 overflow-x-hidden rounded-[22px] border border-[#183039]/10 bg-[#fafcfb]/95 p-2", props.className)}>
      {blocks.map((block) => (
        <div
          key={block.id}
          data-after-line={block.afterLineNumber ?? undefined}
          className={cn(
            "grid min-w-0 grid-cols-[18px_8px_minmax(0,1fr)] gap-1 rounded-[10px] px-1 py-1",
            props.highlightAfterLine !== null &&
            props.highlightAfterLine !== undefined &&
            block.afterLineNumber === props.highlightAfterLine &&
            block.type === "same" &&
            "bg-[#d8a21b]/20",
            block.type === "added" && "bg-[#1d8c68]/10",
            block.type === "removed" && "bg-[#c94a35]/10"
          )}
        >
          <span className="select-none text-right font-mono text-[12px] leading-[1.65] text-[#8b9aa1]">
            {block.lineNumber}
          </span>
          <span className="font-mono text-[13px] leading-[1.65] text-[#4a5b61]">{block.marker}</span>
          <span className="grid min-w-0 gap-0 whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.65]">
            <span className="min-w-0">
              <VisibleWhitespace text={block.line.text} hasNewline={block.line.hasNewline} />
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

function splitDiffLines(value: string): DiffLine[] {
  if (!value) {
    return [];
  }

  const lines = value.split("\n").map((text, index, allLines) => ({
    text,
    hasNewline: index < allLines.length - 1
  }));

  if (value.endsWith("\n")) {
    lines.pop();
  }

  return lines;
}

function VisibleWhitespace(props: { text: string; hasNewline: boolean }): JSX.Element {
  const whitespaceClass = "text-[#c2cdd1]";

  return (
    <>
      {props.text
        ? Array.from(props.text).map((char, index) => {
          if (char === " ") {
            return <span key={index} className={whitespaceClass}>·</span>;
          }
          if (char === "\t") {
            return <span key={index} className={whitespaceClass}>⇥</span>;
          }
          return char;
        })
        : !props.hasNewline ? " " : null}
      {props.hasNewline ? <span className="ml-1 text-[#c2cdd1]">↵</span> : null}
    </>
  );
}
