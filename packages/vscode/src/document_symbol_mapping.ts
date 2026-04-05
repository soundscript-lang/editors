import ts from 'typescript';

import type { EditorProjectSnapshot } from './editor_process_support';
import {
  mapProjectedEnclosingRangeToSource,
  mapProjectedRangeToSource,
} from './projection_mapping';

export interface OffsetRange {
  end: number;
  start: number;
}

export interface MappedDocumentSymbolRanges {
  range: OffsetRange;
  selectionRange: OffsetRange;
}

function combinedTextSpanRange(
  spans: readonly ts.TextSpan[] | undefined,
): OffsetRange | null {
  if (!spans || spans.length === 0) {
    return null;
  }

  let start = spans[0]!.start;
  let end = spans[0]!.start + spans[0]!.length;
  for (const span of spans.slice(1)) {
    start = Math.min(start, span.start);
    end = Math.max(end, span.start + span.length);
  }
  return { start, end };
}

function textMatchesRange(text: string, range: OffsetRange, expected: string): boolean {
  return text.slice(range.start, range.end) === expected;
}

function isDeclarationNameNode(node: ts.Node): boolean {
  return !!node.parent &&
    'name' in node.parent &&
    (node.parent as ts.NamedDeclaration).name === node;
}

function findDeclaredNameRange(
  sourceFile: ts.SourceFile,
  nameText: string,
  searchRange: OffsetRange,
): OffsetRange | null {
  let best: OffsetRange | null = null;

  const visit = (node: ts.Node): void => {
    if (node.getFullStart() > searchRange.end || node.getEnd() < searchRange.start) {
      return;
    }

    if (isDeclarationNameNode(node) && node.getText(sourceFile) === nameText) {
      const candidate = {
        start: node.getStart(sourceFile),
        end: node.getEnd(),
      };
      if (candidate.start >= searchRange.start && candidate.end <= searchRange.end) {
        if (!best || candidate.start < best.start ||
          (candidate.start === best.start && candidate.end <= best.end)) {
          best = candidate;
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return best;
}

function isIdentifierBoundaryCharacter(character: string | undefined): boolean {
  return !character || !/[A-Za-z0-9_$]/u.test(character);
}

function findNameTextRange(
  text: string,
  nameText: string,
  searchRange: OffsetRange,
): OffsetRange | null {
  let index = text.indexOf(nameText, searchRange.start);
  while (index !== -1 && index < searchRange.end) {
    const end = index + nameText.length;
    if (
      end <= searchRange.end &&
      isIdentifierBoundaryCharacter(text[index - 1]) &&
      isIdentifierBoundaryCharacter(text[end])
    ) {
      return { start: index, end };
    }
    index = text.indexOf(nameText, index + 1);
  }
  return null;
}

function recoverSelectionRange(
  sourceFile: ts.SourceFile,
  nameText: string,
  bodyRange: OffsetRange,
): OffsetRange | null {
  return findDeclaredNameRange(sourceFile, nameText, bodyRange) ??
    findNameTextRange(sourceFile.text, nameText, bodyRange);
}

export function mapNavigationTreeItemToSourceRanges(
  snapshot: EditorProjectSnapshot,
  sourceFile: ts.SourceFile,
  item: Pick<ts.NavigationTree, 'nameSpan' | 'spans' | 'text'>,
): MappedDocumentSymbolRanges | null {
  const bodySpan = combinedTextSpanRange(item.spans);
  if (!bodySpan) {
    return null;
  }

  const selectionSpan = item.nameSpan
    ? {
      start: item.nameSpan.start,
      end: item.nameSpan.start + item.nameSpan.length,
    }
    : bodySpan;
  const exactSelection = mapProjectedRangeToSource(
    snapshot,
    selectionSpan.start,
    selectionSpan.end,
  );
  const bodyRange = mapProjectedEnclosingRangeToSource(
    snapshot,
    bodySpan.start,
    bodySpan.end,
  );

  let selectionRange: OffsetRange = {
    start: exactSelection.start,
    end: exactSelection.end,
  };

  if (
    item.nameSpan &&
    (exactSelection.intersectsReplacement ||
      !textMatchesRange(snapshot.originalText, selectionRange, item.text))
  ) {
    const recoveredSelection = recoverSelectionRange(sourceFile, item.text, {
      start: bodyRange.start,
      end: bodyRange.end,
    });
    if (recoveredSelection) {
      selectionRange = recoveredSelection;
    }
  }

  return {
    range: {
      start: selectionRange.start,
      end: bodyRange.end,
    },
    selectionRange,
  };
}
