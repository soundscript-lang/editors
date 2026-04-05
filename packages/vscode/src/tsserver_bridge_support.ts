export interface TsserverLocationLike {
  line: number;
  offset: number;
}

export interface TsserverDiagnosticLike {
  category?: string;
  code?: number | string;
  end?: TsserverLocationLike;
  source?: string;
  start?: TsserverLocationLike;
  text: string;
}

export interface TsserverDiagnosticRange {
  endCharacter: number;
  endLine: number;
  startCharacter: number;
  startLine: number;
}

export interface TsserverDisplayPartLike {
  text: string;
}

export interface TsserverTagLike {
  name: string;
  text?: string | TsserverDisplayPartLike[];
}

export interface TsserverQuickInfoLike {
  displayString: string;
  documentation?: string | TsserverDisplayPartLike[];
  tags?: TsserverTagLike[];
}

export interface BridgeFallbackHoverLike {
  markdown: string;
}

export function flattenDisplayParts(
  value: string | TsserverDisplayPartLike[] | undefined,
): string {
  if (typeof value === 'string') {
    return value;
  }

  if (!Array.isArray(value)) {
    return '';
  }

  return value.map((part) => part.text).join('');
}

export function tsserverCategoryToSeverity(
  category: string | undefined,
): 'error' | 'hint' | 'information' | 'warning' {
  switch (category) {
    case 'error':
      return 'error';
    case 'suggestion':
      return 'hint';
    case 'message':
      return 'information';
    case 'warning':
    default:
      return 'warning';
  }
}

export function toDiagnosticRange(
  diagnostic: TsserverDiagnosticLike,
): TsserverDiagnosticRange | undefined {
  if (!diagnostic.start || !diagnostic.end) {
    return undefined;
  }

  return {
    startLine: Math.max(diagnostic.start.line - 1, 0),
    startCharacter: Math.max(diagnostic.start.offset - 1, 0),
    endLine: Math.max(diagnostic.end.line - 1, 0),
    endCharacter: Math.max(diagnostic.end.offset - 1, 0),
  };
}

export function renderQuickInfoSections(
  body: TsserverQuickInfoLike,
): {
  documentation: string;
  signature: string;
  tags: string[];
} {
  return {
    signature: body.displayString,
    documentation: flattenDisplayParts(body.documentation),
    tags: (body.tags ?? []).map((tag) => {
      const text = flattenDisplayParts(tag.text);
      return text.length > 0 ? `@${tag.name} ${text}` : `@${tag.name}`;
    }),
  };
}

function unwrapMarkdownCodeFence(markdown: string): string {
  const trimmed = markdown.trim();
  const match = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

export function shouldBypassHelperForFallbackHover(
  hover: BridgeFallbackHoverLike | null,
): boolean {
  if (!hover) {
    return false;
  }

  const code = unwrapMarkdownCodeFence(hover.markdown);
  if (code.length === 0) {
    return false;
  }

  return !/(^|[^\w$])any($|[^\w$])/.test(code);
}
