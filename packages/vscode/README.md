# soundscript VS Code Extension

soundscript adds editor support for `.sts` files and mixed `.ts` / `.sts` workspaces.

Current features:

- `.sts` registration through the bundled TypeScript server plugin
- base TypeScript editor behavior in `.sts`
- soundscript syntax highlighting for annotations, built-in macros, and DSL tags
- unused-import suppression for declaration macro imports referenced from `// #[...]`

## Editor Architecture

This extension now uses the TypeScript server plugin path as its editor integration model.
It does not launch a separate soundscript language server from VS Code.

That means `.sts` files should be ordinary TypeScript syntax, and normal TypeScript resolution rules
need to work in the workspace. In particular, install real package dependencies for imported
soundscript libraries such as `@soundscript/soundscript`.

Recommended compiler settings for projects that import packages from `.sts`:

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  }
}
```

`"moduleResolution": "Bundler"` also works in bundler-oriented projects.

## Settings

- `soundscript.tsserver.stsScriptKind`: choose whether `.sts` is exposed to tsserver as `ts` or
  `tsx`.

## Development

For local repository development:

```bash
npm install
npm run compile
npm test
```

Then launch the `Run soundscript extension` configuration from `packages/vscode` or from the editors repo root.

## Packaging And Publish

To build a `.vsix` package locally:

```bash
npm install
npm run package
```

To publish to the Visual Studio Marketplace:

```bash
npm run publish
```

Before publishing, confirm that the `publisher` field in `package.json` matches the Marketplace
publisher you actually control. Publishing requires a valid Marketplace publisher and personal
access token.
