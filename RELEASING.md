# Releasing

Versioning is **semver**, driven by what changed:

| Change | Bump | Example |
| --- | --- | --- |
| Fix, docs, small correction | patch | `v1.1.1` |
| New feature or behaviour | minor | `v1.2.0` |
| Breaking change to install, config or commands | major | `v2.0.0` |

## Release procedure

1. Make sure the working tree is clean and the plugin in `~/.config/opencode/plugins/whatsapp/index.ts`
   matches `src/index.ts`:
   ```bash
   git status --short
   ```
2. Typecheck:
   ```bash
   npm run typecheck
   ```
3. Commit and push:
   ```bash
   git add -A
   git commit -m "<summary>"
   git push origin main
   ```
4. Tag and publish:
   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z - <summary>"
   git push origin vX.Y.Z
   gh release create vX.Y.Z --title "vX.Y.Z - <summary>" --notes-file notes.md
   ```

Keep release notes short: what is new, what was fixed, and how to update.

## Notes

- `BRIDGE_VERSION` in `src/index.ts` must be bumped whenever plugin code changes,
  so a running OpenCode server retires the old bridge instance and reloads.
- Never commit `auth/`, `status.json`, logs, QR images or QR pages.
