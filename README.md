# editors

Editor clients for Soundscript.

This repo currently contains:

- `soundscript-vscode`
- `@soundscript/tsserver-plugin`

Development checks:

- `npm install`
- `npm test`
- `npm run package:vscode`
- `npm run release:publish`
- `npm run release:publish:openvsx`

`npm test` also verifies the `@soundscript/tsserver-plugin` npm tarball surface.

`npm run package:vscode` also verifies that the built VSIX contains the packaged
`@soundscript/tsserver-plugin` runtime payload and excludes test-only files.

Development mode expects a sibling `/soundscript` checkout under the same `soundscript-lang` directory.

Release flow:

1. Confirm `@soundscript/soundscript@0.1.17` is already published.
2. Run `npm test`.
3. Run `npm run package:vscode`.
4. Publish with `npm run release:publish`.

`npm run release:publish` publishes `@soundscript/tsserver-plugin` first, then runs the VS Code
extension publish path. Make sure the extension publisher credentials are already configured.
Set `SOUNDSCRIPT_NPM_OTP=<code>` or `NPM_CONFIG_OTP=<code>` for non-interactive npm publish.

If you upload the VSIX manually in the Marketplace UI, that does not publish
`@soundscript/tsserver-plugin` to npm. The npm package still needs its own publish step.
In that case, run:

`SOUNDSCRIPT_SKIP_VSCODE_PUBLISH=1 npm run release:publish`

OpenVSX / Cursor flow:

1. Create the `soundscript` namespace once on OpenVSX.
2. Build the VSIX with `npm run package:vscode`.
3. Publish the VSIX to OpenVSX with:

`SOUNDSCRIPT_OPENVSX_TOKEN=<token> npm run release:publish:openvsx`

`release:publish:openvsx` will build the VSIX first unless
`SOUNDSCRIPT_SKIP_PACKAGE_VSCODE=1` is set. It also accepts `OVSX_PAT=<token>`.

GitHub Actions also supports release-time extension publishing. Configure
`VSCE_PAT` for the Visual Studio Marketplace and `OVSX_PAT` for OpenVSX in the
`editors` repo secrets, then run the `Release Extension` workflow for an
existing tag if you need to backfill a release.
