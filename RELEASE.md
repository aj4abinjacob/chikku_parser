# Release Checklist

Use this checklist whenever creating a new release tag. Do not create or push a
tag unless every validation step passes.

1. Pick a version newer than every published updater feed version.
2. Update all app version fields before tagging:
   - `package.json`
   - `package-lock.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/Cargo.lock`
   - `src-tauri/tauri.conf.json`
3. Run:
   - `npm run tauri:renderer:build`
   - `cargo check --manifest-path src-tauri/Cargo.toml`
4. Commit the version bump and release changes to `master`.
5. Run the release tag validator from the clean release commit:
   - `npm run release:check -- vX.Y.Z`
   - Confirm it reports the tag is ready.
   - If it fails, fix the reported issue before tagging.
6. Create and push an annotated tag from that exact commit:
   - `git tag -a vX.Y.Z -m "Chikku Parser vX.Y.Z"`
   - `git push origin master`
   - `git push origin vX.Y.Z`
7. Wait for `.github/workflows/release.yml` to complete successfully, including
   the `Publish updater notes` job.
8. Verify the published updater feed:
   - `curl -L https://github.com/aj4abinjacob/chikku_parser/releases/latest/download/latest.json`
   - Confirm `version` equals the tag version.
   - Confirm `notes` is not empty.
   - Confirm macOS x64, macOS arm64, Linux, and Windows platforms are present.

Never tag a feature commit whose app version still matches a previous release.
Never move or replace an existing tag unless explicitly recovering a broken
release with a documented plan.

## Signing Key

Back up the Tauri updater private key and its password in a password manager or secrets manager. Do not commit it to the repository.

The app embeds the matching public key in `src-tauri/tauri.conf.json`. If the private key is lost, existing users cannot verify future auto-updates signed by a new key. Recovery would require distributing a manually installed build that contains the replacement public key.
