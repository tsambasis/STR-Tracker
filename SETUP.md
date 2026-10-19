# STR Hours Tracker — Firebase Setup Guide

This is a fully serverless web app hosted on Firebase (free tier).  
Follow these steps once to get it live. Takes about 15 minutes.

---

## Step 1 — Create a Firebase Project

1. Go to **https://console.firebase.google.com**
2. Click **"Add project"**
3. Name it (e.g. `str-tracker`) → Continue
4. Disable Google Analytics (optional) → **Create project**

---

## Step 2 — Enable Authentication

1. In the Firebase console, click **Authentication** in the left sidebar
2. Click **Get started**
3. Under **Sign-in method**, click **Email/Password**
4. Toggle **Enable** → **Save**

---

## Step 3 — Enable Firestore Database

1. Click **Firestore Database** in the left sidebar
2. Click **Create database**
3. Choose **Start in production mode** → Next
4. Select a location (e.g. `us-east1`) → **Enable**

---

## Step 4 — Enable Firebase Storage (for photo uploads)

1. Click **Storage** in the left sidebar
2. Click **Get started**
3. Choose **Start in production mode** → Next
4. Select the same region you used for Firestore → **Done**

---

## Step 5 — Register a Web App & Get Your Config

1. In the Firebase console, click the **gear icon** (⚙) → **Project settings**
2. Scroll down to **"Your apps"** → click the **</>** (Web) icon
3. Give the app a nickname (e.g. `str-tracker-web`) → click **Register app**
4. You'll see a `firebaseConfig` block like this:

```js
const firebaseConfig = {
  apiKey:            "AIza...",
  authDomain:        "str-tracker.firebaseapp.com",
  projectId:         "str-tracker",
  storageBucket:     "str-tracker.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123456789:web:abc123"
};
```

5. Copy **`public/firebase-config.example.js`** to **`public/firebase-config.js`**
   and replace each `REPLACE_WITH_YOUR_...` / `YOUR_PROJECT_ID` value with your
   actual values.

   `firebase-config.js` is listed in `.gitignore`, so your config is never
   committed. It is still uploaded when you run `firebase deploy`.

---

## Step 6 — Set Yourself as Admin

After you create your first account in the app, you need to manually set your
user as admin in Firestore:

1. Go to **Firestore Database** in the Firebase console
2. Click the **`users`** collection
3. Find your user document (click around — the doc ID is your UID)
4. Find the **`admin`** field → click the pencil icon → change it to **`true`** → **Update**

That's it. The 👑 Admin button will appear in the header next time you load the app.

---

## Step 7 — Deploy Security Rules

The security rules are already written in `firestore.rules` and `storage.rules`.
You need to deploy them so other users can't access your data.

### Option A — Firebase CLI (recommended)

1. Install Node.js if you don't have it: **https://nodejs.org**

2. Install the Firebase CLI:
```bash
npm install -g firebase-tools
```

3. Log in:
```bash
firebase login
```

4. Update `.firebaserc` — replace `REPLACE_WITH_YOUR_FIREBASE_PROJECT_ID`
   with your actual project ID (found in Project Settings).

5. From the `str-tracker-firebase/` folder, deploy everything:
```bash
firebase deploy
```

This deploys:
- The app to **Firebase Hosting** (you'll get a free `https://your-project.web.app` URL)
- The Firestore security rules
- The Storage security rules

### Option B — Copy-paste rules manually

If you don't want to use the CLI:

1. Go to **Firestore Database** → **Rules** tab
2. Paste the contents of `firestore.rules` → **Publish**

3. Go to **Storage** → **Rules** tab
4. Paste the contents of `storage.rules` → **Publish**

5. For hosting, you can use any static host (Netlify, Vercel, GitHub Pages)
   by uploading the contents of the `public/` folder.

---

## Step 8 — Share with Other Families

Each family:
1. Visits your hosted URL (e.g. `https://str-tracker.web.app`)
2. Clicks **Create Account** and registers with their email
3. Their data is **completely isolated** — they cannot see yours and you cannot see theirs
4. You can view all registered users in the **👑 Admin** panel

---

## Free Tier Limits (more than enough)

| Resource | Free limit |
|---|---|
| Firestore reads | 50,000 / day |
| Firestore writes | 20,000 / day |
| Firestore storage | 1 GB |
| Storage (photos) | 5 GB |
| Hosting bandwidth | 10 GB / month |
| Auth users | Unlimited |

A family logging 5 entries/day = ~3,650 writes/year. You'd need 5+ families
logging constantly to approach the daily limits.

---

## File Structure

```
str-tracker-firebase/
├── public/
│   ├── index.html       ← The entire app
│   ├── firebase-config.example.js  ← Copy to firebase-config.js and fill in
│   └── firebase-config.js          ← Your Firebase config (git-ignored)
├── firestore.rules      ← Firestore security rules
├── storage.rules        ← Storage security rules
├── firebase.json        ← Firebase deploy config
├── .firebaserc          ← Your project ID
└── SETUP.md             ← This file
```

---

## Using on Mobile

The app is fully responsive and works on any smartphone browser.

**Add to Home Screen (optional — makes it feel like a native app):**
- **iPhone**: Open in Safari → Share button → "Add to Home Screen"
- **Android**: Open in Chrome → three-dot menu → "Add to Home Screen"

The **📷 Take Photo** button on the log form will open your phone's camera directly.

---

## Troubleshooting

| Issue | Fix |
|---|---|
| "Permission denied" errors | Make sure you deployed `firestore.rules` and `storage.rules` |
| Photos not uploading | Make sure Firebase Storage is enabled and rules are deployed |
| Can't sign in | Check that Email/Password auth is enabled in Firebase console |
| Admin button not showing | Make sure you set `admin: true` on your Firestore user document |
