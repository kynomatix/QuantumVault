# Publishing QuantumVault to the Solana dApp Store

This is a **step-by-step checklist** you run from **your own computer** once it's back
up. You do NOT run this on Replit — the publishing CLI needs your funded Solana wallet's
private key, which must stay off Replit.

QuantumVault on the dApp Store is a **Trusted Web Activity (TWA)**: the APK is a thin
wrapper that loads the live site at https://myquantumvault.com. So:
- The app only works while myquantumvault.com is deployed and reachable.
- A change to the website does NOT need a new APK. You only re-publish a new APK if you
  change the package, icon, or native wrapper.

---

## 0) What's already done (no action needed)

- ✅ Signed APK built: `app-release-signed.apk` (~1.16 MB).
- ✅ Signing keystore created and backed up.
- ✅ `https://myquantumvault.com/.well-known/assetlinks.json` is live and its SHA-256
  fingerprint (`83:B1:3B:C2:…:FC:D9`) matches the APK, so Android app-link verification
  will pass.
- ✅ This `dapp-store/` folder with `config.yaml`, a 512px icon, and listing copy.

---

## 1) Things to gather first

1. **Node.js 18+** installed (`node -v`).
2. **Android build-tools** (the CLI uses `aapt2` to read the APK). Install Android Studio,
   or just the command-line tools, then install build-tools 34:
   ```
   sdkmanager "build-tools;34.0.0"
   ```
   Note the path, e.g.:
   - macOS: `~/Library/Android/sdk/build-tools/34.0.0`
   - Linux: `~/Android/Sdk/build-tools/34.0.0`
   - Windows: `%LOCALAPPDATA%\Android\Sdk\build-tools\34.0.0`
   We'll call this `<BUILD_TOOLS_DIR>` below.
3. **A funded Solana mainnet keypair file** (`keypair.json`, the standard array-of-bytes
   format from `solana-keygen`). This wallet becomes the permanent owner/authority of your
   publisher + app NFTs. Keep ~**0.1 SOL** on it for mint + asset-upload fees. We'll call
   this `<KEYPAIR.json>`. **Never put this file on Replit or in git.**
4. **A reliable mainnet RPC URL** (e.g. a Helius mainnet URL). Public RPCs get
   rate-limited during uploads. We'll call this `<RPC_URL>`.

---

## 2) Download the two files from Replit to your machine

Pull this repo on your machine, then copy these out of the Replit workspace (they are
**gitignored**, so they are NOT in the repo — download them from the Replit file pane):

| From (in Replit)                                       | To (on your machine)                         |
|--------------------------------------------------------|----------------------------------------------|
| `.local/android/twa/app-release-signed.apk`            | `dapp-store/files/app-release-signed.apk`    |
| `.local/android/quantumvault-keystore-backup.tar.gz`   | somewhere safe & off-Replit (for FUTURE updates only) |

The keystore backup is **not needed for this submission** — only the APK is. But keep it
safe forever: lose it and you can never ship an update to this listing.

---

## 3) Finish the listing

1. Add **at least 4 phone screenshots** to `dapp-store/media/` named
   `screenshot_1.png` … `screenshot_4.png` (portrait, native resolution).
   - Your Seeker is airgapped — capture there and transfer, or capture on any Android
     device / emulator running the app.
2. (Optional) add `dapp-store/media/banner.png` (~1200×600) and uncomment the `banner`
   lines in `config.yaml`.
3. Open `config.yaml` and fill in every `<ANGLE_BRACKET>` placeholder:
   `publisher.name`, `publisher.email`, and the reviewer `testing_instructions`.
   - Edit the marketing text in `LISTING.md` first if you want, then paste the final
     wording into `config.yaml`. (Keep `name` ≤ 30 chars and `short_description` ≤ 30 chars.)

---

## 4) Validate, mint, submit

Run all commands from inside the `dapp-store/` folder.

> First run installs the CLI: `npm install` (uses the bundled `package.json`), then use
> `npx dapp-store …`. If you'd rather not install, replace `npx dapp-store` with
> `npx --yes @solana-mobile/dapp-store-cli@latest` in every command below.

**a. Validate the config + APK** (no on-chain action, no wallet needed):
```
npx dapp-store validate -b <BUILD_TOOLS_DIR>
```
Fix anything it flags (image sizes, missing screenshots, field lengths) before continuing.

**b. Create the Publisher NFT — ONCE EVER** (skip on all future updates):
```
npx dapp-store create publisher -k <KEYPAIR.json> -u <RPC_URL>
```
This writes `publisher.address` back into `config.yaml`.

**c. Create the App NFT — ONCE per app** (skip on all future updates):
```
npx dapp-store create app -k <KEYPAIR.json> -u <RPC_URL>
```
This writes `app.address` back into `config.yaml`.

**d. Create the Release NFT — EVERY release** (uploads the APK + media):
```
npx dapp-store create release -k <KEYPAIR.json> -u <RPC_URL> -b <BUILD_TOOLS_DIR>
```
This writes `release.address` back into `config.yaml`.

**e. Submit for review:**
```
npx dapp-store publish submit -k <KEYPAIR.json> -u <RPC_URL> \
  --requestor-is-authorized \
  --complies-with-solana-dapp-store-policies
```

Then watch for the review result from the Solana Mobile team (they contact the publisher
email). Approval lists the app in the dApp Store.

---

## 5) Shipping an update later (for reference)

When you change the website only: nothing to do — the TWA loads it live.

When you must ship a NEW APK (new icon/package/wrapper):
1. Rebuild & **sign with the SAME keystore** (see `.agents/memory/dapp-store-twa-publishing.md`).
2. Bump `versionCode`/`versionName` in the TWA build.
3. Copy the new APK to `dapp-store/files/`, set `release.new_in_version` in `config.yaml`.
4. Run **only** `create release` then `publish update` (NOT `create publisher`/`create app`):
   ```
   npx dapp-store create release -k <KEYPAIR.json> -u <RPC_URL> -b <BUILD_TOOLS_DIR>
   npx dapp-store publish update -k <KEYPAIR.json> -u <RPC_URL> \
     --requestor-is-authorized --complies-with-solana-dapp-store-policies
   ```

---

## Gotchas

- **`android_package` must never change** — it must equal `com.myquantumvault.app`
  everywhere (APK, assetlinks, this config) or app-link verification fails.
- **Keep the keypair safe** — it is the permanent authority for your publisher and app.
  Losing it means you can't update the listing.
- **CLI version drift:** the exact flag names can change between CLI versions. If a command
  errors on a flag, run `npx dapp-store <command> --help` and check the official docs:
  https://docs.solanamobile.com/dapp-publishing/overview
