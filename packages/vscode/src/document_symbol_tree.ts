import ts from 'typescript';

function isQuotedModuleName(text: string): boolean {
  return text.startsWith('"') && text.endsWith('"');
}

function spansWholeProjectedFile(
  spans: readonly ts.TextSpan[] | undefined,
  projectedTextLength: number,
): boolean {
  return (spans ?? []).some((span) => span.start === 0 && span.length >= projectedTextLength);
}

export function isSyntheticNavigationTreeItem(tree: Pick<ts.NavigationTree, 'text'>): boolean {
  return tree.text.startsWith('__sts_') || tree.text === '<function>' || tree.text === '<class>';
}

export function isNavigationTreeRoot(
  tree: Pick<ts.NavigationTree, 'kind' | 'spans' | 'text'>,
  projectedTextLength: number,
): boolean {
  return tree.text === '<root>' ||
    tree.text === '<global>' ||
    tree.kind === ts.ScriptElementKind.scriptElement ||
    (
      tree.kind === ts.ScriptElementKind.moduleElement &&
      isQuotedModuleName(tree.text) &&
      (
        tree.text.endsWith('.sts"') ||
        spansWholeProjectedFile(tree.spans, projectedTextLength)
      )
    );
}
