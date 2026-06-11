# Publishing QuantumVault to the Solana dApp Store

> **IMPORTANT — the process changed (April 2026).** Publishing is now done through a
> **website** (the Solana dApp Publisher Portal), not the old command-line + `config.yaml`
> flow. So you do **NOT** need any of these anymore:
> - ❌ the `config.yaml` file (kept only as copy-paste text for the web form)
> - ❌ Android Studio / build-tools (the old `-b` flag is gone)
> - ❌ a `keypair.json` file or an RPC URL
> - ❌ the `npm install` / `dapp-store validate / create publisher / create app / create release / publish submit` commands
>
> Everything below replaces the old steps. The good news: **all the assets and text we
> prepared are still used** — you just upload/paste them on the website instead.

QuantumVault on the dApp Store is a **Trusted Web Activity (TWA)**: the APK is a thin
wrapper that loads the live site at https://myquantumvault.com. So a change to the website
does NOT need a new APK — you only re-publish a new APK if you change the package, icon, or
native wrapper.

---

## What you already have (nothing wasted)

| Asset | Where it is |
|-------|-------------|
| ✅ Signed APK | `dapp-store/files/app-release-signed.apk` |
| ✅ App icon (512×512) | `dapp-store/media/app_icon.png` |
| ✅ 4 screenshots | `dapp-store/media/Screenshot_1.jpg` … `Screenshot_4.jpg` |
| ✅ Banner (1200×600) | `dapp-store/media/Banner.jpg` |
| ✅ All listing text (name, short + long description, "what's new") | `dapp-store/LISTING.md` (and `config.yaml`) — copy-paste into the web form |

---

## What you need before starting

1. **A browser wallet** — Phantom, Solflare, or Backpack. This becomes your **publisher
   wallet**. ⚠️ Keep it (and its seed phrase) forever — **every** future update to this app
   must be signed by this same wallet.
2. **~0.2 SOL** in that wallet — covers network fees + the cost of uploading your assets to
   permanent storage.
3. **Your developer email** — review results are sent here.
4. **Identity verification (KYC/KYB)** — the portal asks you to verify your identity as a
   publisher before you can submit. Have your ID / business details ready; this can take a
   little time to clear.

---

## Steps — all done on the website

### 1. Sign up
Go to **https://publish.solanamobile.com** and create a publisher account. Fill out your
publisher profile and complete the **KYC/KYB** identity verification.

### 2. Connect your publisher wallet
Connect Phantom / Solflare / Backpack. Make sure it holds **~0.2 SOL**.

### 3. Choose a storage provider
Pick **ArDrive** (recommended). This is where your APK, icon, screenshots, and banner get
stored permanently. The portal shows an estimated SOL cost based on your file sizes.

### 4. Add your dApp details
Bottom-left menu → **"Add a dApp" → "New dApp"**, then fill the form:
- **Name:** QuantumVault
- **Short + long description:** copy from `LISTING.md`
- **Icon:** upload `media/app_icon.png`
- **Screenshots:** upload the four `Screenshot_1.jpg` … `Screenshot_4.jpg`
- **Banner / feature graphic:** upload `Banner.jpg`
- **Website:** https://myquantumvault.com
- The **package name** (`com.myquantumvault.app`) is read automatically from the APK.

Save the form. You can edit these details later.

### 5. Submit your first release
Go to the app's **Home** → top-right **"New Version"** → upload
`files/app-release-signed.apk` → fill in **"What's new"** → **Submit**.

You'll be prompted to **sign several wallet messages/transactions** — these upload your
assets to storage and mint the release. ⚠️ **Approve every prompt; don't skip any**, or some
assets won't make it into the submission.

---

## After you submit
- It enters the review queue automatically.
- Results are emailed from `publishersupport@dappstore.solanamobile.com` within **3–5
  business days**.
- Once approved, it goes live in the dApp Store automatically.
- No response after 5 business days? Ask in the `#dev-answers` channel on the
  [Solana Mobile Discord](http://discord.gg/solanamobile).

---

## Shipping an update later
- **Website-only change:** nothing to do — the TWA loads the live site.
- **New APK** (new icon/package/wrapper): sign with the **same keystore**, bump
  `versionCode`/`versionName`, then in the portal go to your app → **New Version** → upload
  the new APK (or pick **"use existing APK"** if you're only changing listing text).

---

## Optional: the command-line tool (for automation later — ignore for now)
Once your app exists in the portal, you *can* push future updates from the command line
instead of the website:
```
npm install -g @solana-mobile/dapp-store-cli
# get an API key from the portal: Settings → API keys
$env:DAPP_STORE_API_KEY="<your-api-key>"
dapp-store --apk-file .\files\app-release-signed.apk --keypair .\keypair.json --whats-new "Bug fixes"
```
This needs a portal API key **and** a Solana CLI keypair file. You do **not** need it for
your first submission — use the website.

---

## Keep these safe forever
- **Your publisher wallet + seed phrase** — the permanent authority for this app.
- **Your signing keystore backup** (`.local/android/quantumvault-keystore-backup.tar.gz`,
  downloaded off Replit) — lose it and you can never ship an APK update.

Official guide: https://docs.solanamobile.com/dapp-store/submit-new-app
