# Publishing

What is prepared, what is left, and the exact commands. Everything here needs credentials that live
with the maintainer, so none of it can be automated from a build machine without a secret.

## Before the first publish

1. **A publisher.** Create one at <https://marketplace.visualstudio.com/manage>. The identifier has
   to match `publisher` in `package.json` (currently `hivey`).
2. **A token.** Azure DevOps → *Personal Access Tokens* → scope **Marketplace ▸ Manage**,
   organisation **All accessible organisations**. That token is the only thing standing between
   someone and publishing under your name: store it in a password manager, not in a shell history.
3. **Open VSX** (for VSCodium, Cursor, Gitpod, Theia): create an account at <https://open-vsx.org>,
   sign the publisher agreement, and generate a token.

## Every release

```bash
npm ci
npm run typecheck
npm test                    # 128 tests
xvfb-run -a npm run test:integration   # 8 tests inside a real VS Code
npm run scan:secrets
npm audit --audit-level=high

# Bump the version and write the changelog entry BEFORE packaging: both are shipped.
npm version minor --no-git-tag-version
$EDITOR CHANGELOG.md

npm run build
npx @vscode/vsce@3 package --no-dependencies -o forge.vsix
```

Install the `.vsix` locally and use it for an hour before publishing it. The suite catches what it
was written to catch; it does not catch a panel that feels wrong.

```bash
npx @vscode/vsce@3 publish --no-dependencies   # asks for the token, or reads $VSCE_PAT
npx ovsx publish forge.vsix -p "$OVSX_PAT"     # Open VSX
git tag "v$(node -p 'require("./package.json").version')" && git push --tags
```

## What the Marketplace shows

- **README.md** — the English one. Relative image links are rewritten to the repository by `vsce`,
  which is why `docs/images/**` is excluded from the package but must stay in the repository.
- **CHANGELOG.md** — the *Changelog* tab.
- `displayName`, `description`, `categories`, `keywords`, `icon`, `galleryBanner`, `pricing` and
  `badges` from `package.json`. `description` comes from `package.nls.json`, so it is localised.
- The **verified publisher** badge requires a domain verification; it is worth doing before asking a
  company to install this.

## Checks that are easy to forget

- `npx @vscode/vsce@3 ls` prints exactly what will ship. Look at it: the package should contain the
  two bundles, the panel assets, the manifest, the licence and the documents — and nothing else.
- The extension declares **no runtime dependency**; `--no-dependencies` keeps `vsce` from trying to
  resolve any.
- `package.nls.json` must have an entry for every `%key%` in `package.json`. An integration test
  fails when one is missing, because the alternative is a command palette showing
  `%command.newSession.title%` to everyone.
- Node ≥ 20 is required by `@vscode/vsce@3`.

## Not done yet

- Neither Marketplace nor Open VSX publication has happened: it needs the tokens above.
- No signed release and no reproducible build. `esbuild` and `typescript` are in the trusted set,
  which is the residual risk `docs/adr/0004` accepts.
