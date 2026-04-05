import type { EditorProjectSnapshot } from './editor_process_support';
import { mapProjectedRangeToSource } from './projection_mapping';

type ProjectionSnapshotLike = Pick<
  EditorProjectSnapshot,
  'originalText' | 'postRewriteStage' | 'projectedText' | 'rewriteStage'
>;

interface IdentifierSpan {
  end: number;
  start: number;
  text: string;
}

function isIdentifierCharacter(character: string | undefined): boolean {
  return !!character && /[\w$]/.test(character);
}

function isIdentifierBoundaryCharacter(character: string | undefined): boolean {
  return !isIdentifierCharacter(character);
}

export function findIdentifierSpanAtOffset(
  text: string,
  offset: number,
): IdentifierSpan | null {
  const clampedOffset = Math.max(0, Math.min(offset, text.length));
  let anchor = clampedOffset;
  if (!isIdentifierCharacter(text[anchor])) {
    anchor -= 1;
  }

  if (anchor < 0 || !isIdentifierCharacter(text[anchor])) {
    return null;
  }

  let start = anchor;
  let end = anchor + 1;
  while (start > 0 && isIdentifierCharacter(text[start - 1])) {
    start -= 1;
  }
  while (end < text.length && isIdentifierCharacter(text[end])) {
    end += 1;
  }

  return {
    start,
    end,
    text: text.slice(start, end),
  };
}

function findIdentifierOccurrences(
  text: string,
  identifier: string,
): readonly number[] {
  const starts: number[] = [];
  let searchFrom = 0;
  while (searchFrom <= text.length) {
    const index = text.indexOf(identifier, searchFrom);
    if (index === -1) {
      break;
    }

    const end = index + identifier.length;
    if (
      isIdentifierBoundaryCharacter(text[index - 1]) &&
      isIdentifierBoundaryCharacter(text[end])
    ) {
      starts.push(index);
    }

    searchFrom = index + 1;
  }
  return starts;
}

export function recoverProjectedIdentifierOffset(
  snapshot: ProjectionSnapshotLike,
  sourceOffset: number,
  fallbackProjectedOffset: number,
): number | undefined {
  const identifier = findIdentifierSpanAtOffset(snapshot.originalText, sourceOffset);
  if (!identifier) {
    return undefined;
  }

  const cursorDelta = Math.max(
    0,
    Math.min(identifier.text.length - 1, sourceOffset - identifier.start),
  );
  let best: { distance: number; offset: number } | null = null;

  for (const occurrenceStart of findIdentifierOccurrences(snapshot.projectedText, identifier.text)) {
    const occurrenceEnd = occurrenceStart + identifier.text.length;
    const mapped = mapProjectedRangeToSource(snapshot, occurrenceStart, occurrenceEnd);
    if (sourceOffset < mapped.start || sourceOffset >= mapped.end) {
      continue;
    }

    const recoveredOffset = occurrenceStart + cursorDelta;
    const distance = Math.abs(recoveredOffset - fallbackProjectedOffset);
    if (!best || distance < best.distance) {
      best = {
        distance,
        offset: recoveredOffset,
      };
    }
  }

  return best?.offset;
}
