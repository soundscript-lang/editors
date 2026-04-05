import assert from 'node:assert/strict';
import test from 'node:test';

import ts from 'typescript';

import type { EditorProjectSnapshot } from './editor_process_support';
import { mapNavigationTreeItemToSourceRanges } from './document_symbol_mapping';
import { mapProjectedRangeToSource } from './projection_mapping';

const SNAPSHOT = JSON.parse(String.raw`{
  "command": "editor-project",
  "filePath": "/workspace/src/index.sts",
  "originalText": "export function safeDivide(dividend: number, divisor: number): Result<number, string> {\n  if (divisor === 0) {\n    return err('divide_by_zero');\n  }\n\n  return ok(dividend / divisor);\n}\n\nexport function divideThreeWays(\n  a: number,\n  b: number\n) {\n  return Match (safeDivide(a, b), [\n    ({ value }: Ok<number>) => true,\n    ({ error }: Err<string>) => false\n  ]);\n}\n\nconst o1 = Object.create(null);\nconst o2: object = o1;\n",
  "projectPath": "/workspace/tsconfig.json",
  "projectedText": "import type { Result, Option, Ok, Err, Some, None } from 'sts:prelude';\nimport { ok, err, some, none, isOk, isErr, isSome, isNone, Failure, where } from 'sts:prelude';\nexport function safeDivide(dividend: number, divisor: number): Result<number, string> {\n    if (divisor === 0) {\n        return err('divide_by_zero');\n    }\n    return ok(dividend / divisor);\n}\nexport function divideThreeWays(a: number, b: number) {\n    return  (() => {\n        const __sts_match_value = (safeDivide(a, b));\n        if (isOk(__sts_match_value)) {\n            return (({ value }: Ok<number>) => true)(__sts_match_value);\n        }\n        if (isErr(__sts_match_value)) {\n            return (({ error }: Err<string>) => false)(__sts_match_value);\n        }\n        throw new Error(\"Match reached an unexpected non-exhaustive state.\");\n    })() ;\n}\nconst o1 = Object.create(null);\nconst o2: object = o1;\n",
  "rewriteStage": {
    "replacements": [
      {
        "originalSpan": {
          "start": 257,
          "end": 363
        },
        "rewrittenSpan": {
          "start": 257,
          "end": 655
        }
      }
    ],
    "rewrittenText": "export function safeDivide(dividend: number, divisor: number): Result<number, string> {\n  if (divisor === 0) {\n    return err('divide_by_zero');\n  }\n\n  return ok(dividend / divisor);\n}\n\nexport function divideThreeWays(\n  a: number,\n  b: number\n) {\n  return  (() => {\n        const __sts_match_value = (safeDivide(a, b));\n        if (isOk(__sts_match_value)) {\n            return (({ value }: Ok<number>) => true)(__sts_match_value);\n        }\n        if (isErr(__sts_match_value)) {\n            return (({ error }: Err<string>) => false)(__sts_match_value);\n        }\n        throw new Error(\"Match reached an unexpected non-exhaustive state.\");\n    })() ;\n}\n\nconst o1 = Object.create(null);\nconst o2: object = o1;\n"
  },
  "postRewriteStage": {
    "lineMappings": [
      {
        "originalEnd": 88,
        "originalStart": 0,
        "rewrittenEnd": 256,
        "rewrittenStart": 168
      },
      {
        "originalEnd": 111,
        "originalStart": 88,
        "rewrittenEnd": 281,
        "rewrittenStart": 256
      },
      {
        "originalEnd": 145,
        "originalStart": 111,
        "rewrittenEnd": 319,
        "rewrittenStart": 281
      },
      {
        "originalEnd": 149,
        "originalStart": 145,
        "rewrittenEnd": 325,
        "rewrittenStart": 319
      },
      {
        "originalEnd": 183,
        "originalStart": 150,
        "rewrittenEnd": 360,
        "rewrittenStart": 325
      },
      {
        "originalEnd": 185,
        "originalStart": 183,
        "rewrittenEnd": 362,
        "rewrittenStart": 360
      },
      {
        "originalEnd": 267,
        "originalStart": 248,
        "rewrittenEnd": 439,
        "rewrittenStart": 418
      },
      {
        "originalEnd": 321,
        "originalStart": 267,
        "rewrittenEnd": 493,
        "rewrittenStart": 439
      },
      {
        "originalEnd": 360,
        "originalStart": 321,
        "rewrittenEnd": 532,
        "rewrittenStart": 493
      },
      {
        "originalEnd": 433,
        "originalStart": 360,
        "rewrittenEnd": 605,
        "rewrittenStart": 532
      },
      {
        "originalEnd": 443,
        "originalStart": 433,
        "rewrittenEnd": 615,
        "rewrittenStart": 605
      },
      {
        "originalEnd": 483,
        "originalStart": 443,
        "rewrittenEnd": 655,
        "rewrittenStart": 615
      },
      {
        "originalEnd": 558,
        "originalStart": 483,
        "rewrittenEnd": 730,
        "rewrittenStart": 655
      },
      {
        "originalEnd": 568,
        "originalStart": 558,
        "rewrittenEnd": 740,
        "rewrittenStart": 730
      },
      {
        "originalEnd": 646,
        "originalStart": 568,
        "rewrittenEnd": 818,
        "rewrittenStart": 740
      },
      {
        "originalEnd": 657,
        "originalStart": 646,
        "rewrittenEnd": 829,
        "rewrittenStart": 818
      },
      {
        "originalEnd": 659,
        "originalStart": 657,
        "rewrittenEnd": 831,
        "rewrittenStart": 829
      },
      {
        "originalEnd": 692,
        "originalStart": 660,
        "rewrittenEnd": 863,
        "rewrittenStart": 831
      },
      {
        "originalEnd": 715,
        "originalStart": 692,
        "rewrittenEnd": 886,
        "rewrittenStart": 863
      }
    ],
    "replacements": [
      {
        "mappedSegments": [],
        "originalSpan": {
          "start": 0,
          "end": 0
        },
        "rewrittenSpan": {
          "start": 0,
          "end": 168
        }
      },
      {
        "mappedSegments": [],
        "originalSpan": {
          "start": 149,
          "end": 150
        },
        "rewrittenSpan": {
          "start": 325,
          "end": 325
        }
      },
      {
        "mappedSegments": [
          {
            "originalEnd": 186,
            "originalStart": 185,
            "rewrittenEnd": 418,
            "rewrittenStart": 417
          }
        ],
        "originalSpan": {
          "start": 185,
          "end": 248
        },
        "rewrittenSpan": {
          "start": 362,
          "end": 418
        }
      },
      {
        "mappedSegments": [],
        "originalSpan": {
          "start": 659,
          "end": 660
        },
        "rewrittenSpan": {
          "start": 831,
          "end": 831
        }
      }
    ],
    "rewrittenText": "import type { Result, Option, Ok, Err, Some, None } from 'sts:prelude';\nimport { ok, err, some, none, isOk, isErr, isSome, isNone, Failure, where } from 'sts:prelude';\nexport function safeDivide(dividend: number, divisor: number): Result<number, string> {\n    if (divisor === 0) {\n        return err('divide_by_zero');\n    }\n    return ok(dividend / divisor);\n}\nexport function divideThreeWays(a: number, b: number) {\n    return  (() => {\n        const __sts_match_value = (safeDivide(a, b));\n        if (isOk(__sts_match_value)) {\n            return (({ value }: Ok<number>) => true)(__sts_match_value);\n        }\n        if (isErr(__sts_match_value)) {\n            return (({ error }: Err<string>) => false)(__sts_match_value);\n        }\n        throw new Error(\"Match reached an unexpected non-exhaustive state.\");\n    })() ;\n}\nconst o1 = Object.create(null);\nconst o2: object = o1;\n"
  },
  "virtualModules": []
}`) as EditorProjectSnapshot;

function createNavigationTree(
  fileName: string,
  sourceText: string,
): ts.NavigationTree {
  const compilerOptions: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  };
  const host: ts.LanguageServiceHost = {
    fileExists: ts.sys.fileExists,
    getCompilationSettings: () => compilerOptions,
    getCurrentDirectory: () => '/workspace',
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    getNewLine: () => ts.sys.newLine,
    getScriptFileNames: () => [fileName],
    getScriptKind: () => ts.ScriptKind.TS,
    getScriptSnapshot: (requestedFileName) =>
      requestedFileName === fileName ? ts.ScriptSnapshot.fromString(sourceText) : undefined,
    getScriptVersion: () => '1',
    readDirectory: ts.sys.readDirectory,
    readFile: ts.sys.readFile,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  };
  const service = ts.createLanguageService(host);
  return service.getNavigationTree(fileName);
}

function findNavigationItem(
  tree: ts.NavigationTree,
  name: string,
): ts.NavigationTree | null {
  if (tree.text === name) {
    return tree;
  }

  for (const child of tree.childItems ?? []) {
    const match = findNavigationItem(child, name);
    if (match) {
      return match;
    }
  }

  return null;
}

test('mapNavigationTreeItemToSourceRanges recovers names whose exact mapping lands inside macro replacements', () => {
  const lookupFileName = '/workspace/src/index.ts';
  const navigationTree = createNavigationTree(lookupFileName, SNAPSHOT.projectedText);
  const divideThreeWays = findNavigationItem(navigationTree, 'divideThreeWays');
  assert.ok(divideThreeWays?.nameSpan, 'Expected divideThreeWays to have a navigation-tree name span.');

  const rawNameRange = mapProjectedRangeToSource(
    SNAPSHOT,
    divideThreeWays.nameSpan.start,
    divideThreeWays.nameSpan.start + divideThreeWays.nameSpan.length,
  );
  assert.equal(rawNameRange.intersectsReplacement, true);

  const originalSourceFile = ts.createSourceFile(
    SNAPSHOT.filePath,
    SNAPSHOT.originalText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const mapped = mapNavigationTreeItemToSourceRanges(
    SNAPSHOT,
    originalSourceFile,
    divideThreeWays,
  );
  assert.ok(mapped, 'Expected divideThreeWays to map back to a source range.');

  const expectedStart = SNAPSHOT.originalText.indexOf('divideThreeWays');
  assert.deepEqual(mapped.selectionRange, {
    start: expectedStart,
    end: expectedStart + 'divideThreeWays'.length,
  });
});

test('mapNavigationTreeItemToSourceRanges leaves stable declaration names unchanged', () => {
  const lookupFileName = '/workspace/src/index.ts';
  const navigationTree = createNavigationTree(lookupFileName, SNAPSHOT.projectedText);
  const safeDivide = findNavigationItem(navigationTree, 'safeDivide');
  assert.ok(safeDivide, 'Expected safeDivide to exist in the navigation tree.');

  const originalSourceFile = ts.createSourceFile(
    SNAPSHOT.filePath,
    SNAPSHOT.originalText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const mapped = mapNavigationTreeItemToSourceRanges(
    SNAPSHOT,
    originalSourceFile,
    safeDivide,
  );
  assert.ok(mapped, 'Expected safeDivide to map back to a source range.');

  const expectedStart = SNAPSHOT.originalText.indexOf('safeDivide');
  assert.deepEqual(mapped.selectionRange, {
    start: expectedStart,
    end: expectedStart + 'safeDivide'.length,
  });
});
