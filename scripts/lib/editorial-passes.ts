import type { EditorialSource } from '../../types/editorial.js';
import { parseSrt } from './srt.js';

export interface EditorialPass {
  from: number;
  to: number;
}

// Bound the requested answer, not the film context. A whole film can fit in the
// input window while still requiring far more output than one turn will return.
export function editorialPasses(data: EditorialSource): EditorialPass[] {
  const passes: EditorialPass[] = [];
  let start = 0;
  while (start < data.anchors.length) {
    let end = start,
      characters = 0,
      origins = new Set<string>();
    while (end < data.anchors.length) {
      const anchor = data.anchors[end];
      if (
        end > start &&
        (end - start >= 1200 ||
          characters + anchor.text.length > 5000 ||
          (!origins.has(anchor.origin) && origins.size >= 100))
      )
        break;
      characters += anchor.text.length;
      origins.add(anchor.origin);
      end++;
    }
    // Prefer a source cue boundary, retaining a hard upper bound for unusually
    // long monologues. Native word anchors remain valid split points.
    if (end < data.anchors.length) {
      const minimum = start + Math.floor((end - start) * 0.75);
      for (let split = end; split > minimum; split--) {
        if (data.anchors[split - 1].origin !== data.anchors[split].origin) {
          end = split;
          break;
        }
      }
    }
    passes.push({ from: start + 1, to: end });
    start = end;
  }
  return passes;
}

export function editorialPassSource(data: EditorialSource, pass: EditorialPass): EditorialSource {
  const anchors = data.anchors.slice(pass.from - 1, pass.to).map((a, i) => ({ ...a, id: i + 1 }));
  return {
    ...data,
    anchors,
    audioEvents: data.audioEvents.filter(
      (e) => e.end >= anchors[0].start && e.start <= anchors.at(-1)!.end,
    ),
  };
}

export function filmContext(source: string): string {
  return parseSrt(source)
    .map((cue) => cue.text)
    .join('\n');
}

export function restoreEditorialAnchorIds(candidate: string, pass: EditorialPass): any[] {
  const parsed = JSON.parse(candidate);
  return parsed.cues.map((cue: any) => ({
    ...cue,
    parts: cue.parts.map((part: any) => ({
      ...part,
      from: part.from + pass.from - 1,
      to: part.to + pass.from - 1,
    })),
  }));
}
