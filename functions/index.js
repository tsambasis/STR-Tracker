/* eslint-disable */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const admin                  = require('firebase-admin');
const https                  = require('https');

admin.initializeApp();

// Store the Firebase web API key as a secret:
//   firebase functions:secrets:set WEB_API_KEY
// Then enter your project's web API key when prompted.
const WEB_API_KEY = defineSecret('WEB_API_KEY');

/**
 * approveAccountRequest
 *
 * Callable function (admin-only).
 *
 * Flow:
 *  1. Verify the caller is an admin.
 *  2. Check the accountRequest document is still 'pending'.
 *  3. Create a Firebase Auth user (random temp password — they never use it).
 *  4. Create the Firestore user profile doc.
 *  5. Send a password-reset email via the Identity Toolkit REST API so the
 *     user can set their own password.
 *  6. Mark the accountRequest as 'approved'.
 *
 * Called from the app with:
 *   httpsCallable(functions, 'approveAccountRequest')({ requestId, email, name })
 */
exports.approveAccountRequest = onCall(
  { secrets: [WEB_API_KEY] },
  async (request) => {
    const context = request;   // v2: auth lives on request.auth
    const data    = request.data;

    // ── 1. Auth check ──────────────────────────────────────────────────────────
    if (!context.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in.');
    }

    const callerDoc = await admin.firestore()
      .collection('users')
      .doc(context.auth.uid)
      .get();

    if (!callerDoc.exists || callerDoc.data().admin !== true) {
      throw new HttpsError('permission-denied', 'Only admins can approve requests.');
    }

    // ── 2. Validate inputs ─────────────────────────────────────────────────────
    const { requestId, email, name } = data;
    if (!requestId || !email || !name) {
      throw new HttpsError('invalid-argument', 'requestId, email, and name are required.');
    }

    // ── 3. Confirm the request still exists and is pending ────────────────────
    const reqRef  = admin.firestore().collection('accountRequests').doc(requestId);
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists) {
      throw new HttpsError('not-found', 'Account request not found.');
    }
    if (reqSnap.data().status !== 'pending') {
      throw new HttpsError('failed-precondition', 'Request is no longer pending.');
    }

    // ── 4. Create the Auth user ────────────────────────────────────────────────
    let userRecord;
    try {
      userRecord = await admin.auth().createUser({
        email:         email,
        displayName:   name,
        emailVerified: false,
        // Random temp password — user will set their real password via the reset link.
        password: Math.random().toString(36).slice(2) +
                  Math.random().toString(36).slice(2).toUpperCase() + '!0',
      });
    } catch (err) {
      if (err.code === 'auth/email-already-exists') {
        // Re-approval scenario — account already exists in Auth.
        userRecord = await admin.auth().getUserByEmail(email);
      } else {
        throw new HttpsError('internal', 'Failed to create Auth user: ' + err.message);
      }
    }

    // ── 5. Create/upsert Firestore user profile ────────────────────────────────
    await admin.firestore().collection('users').doc(userRecord.uid).set({
      email,
      name,
      meName:     name,
      wifeName:   'My Partner',
      properties: [],
      year:       String(new Date().getFullYear()),
      admin:      false,
      disabled:   false,
      createdAt:  admin.firestore.FieldValue.serverTimestamp(),
      approvedBy: context.auth.uid,
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // ── 6. Send password-reset email ────────────────────────────────────────────
    // The Identity Toolkit REST API sends Firebase's built-in "reset password"
    // email.  For a brand-new user this is their "set your password" link.
    const apiKey = WEB_API_KEY.value();
    if (apiKey) {
      try {
        await sendPasswordResetEmailViaRest(email, apiKey);
      } catch (emailErr) {
        // Non-fatal — account is created; admin can trigger reset manually.
        console.warn('Password-reset email failed:', emailErr.message);
      }
    } else {
      console.warn('WEB_API_KEY secret not set — password-reset email not sent.');
    }

    // ── 7. Mark the request as approved ──────────────────────────────────────
    await reqRef.update({
      status:     'approved',
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      approvedBy: context.auth.uid,
      uid:        userRecord.uid,
    });

    return { success: true, uid: userRecord.uid };
  }
);

/**
 * submitAccessRequest
 *
 * Callable function — PUBLIC (no sign-in needed), used by the "Request Access" form.
 *
 * Firestore rules block unauthenticated reads of accountRequests, so the duplicate
 * check has to happen here with admin access.
 *
 * Behaviour:
 *  - If an Auth account already exists for the email → re-send the set/reset
 *    password link instead of creating another request.
 *  - Otherwise, if a pending request already exists → do nothing new (don't duplicate).
 *  - Otherwise → create a new pending request.
 *
 * Returns { status: 'link_resent' | 'already_pending' | 'submitted' }.
 */
exports.submitAccessRequest = onCall(
  { secrets: [WEB_API_KEY] },
  async (request) => {
    const { name, email, reason } = request.data || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanName  = String(name || '').trim();
    if (!cleanName || !cleanEmail) {
      throw new HttpsError('invalid-argument', 'Name and email are required.');
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
      throw new HttpsError('invalid-argument', 'Please enter a valid email address.');
    }

    // 1. Existing account → re-send the password link
    let hasAccount = false;
    try {
      await admin.auth().getUserByEmail(cleanEmail);
      hasAccount = true;
    } catch (err) {
      if (err.code !== 'auth/user-not-found') {
        throw new HttpsError('internal', 'Could not check existing accounts.');
      }
    }

    if (hasAccount) {
      const apiKey = WEB_API_KEY.value();
      if (!apiKey) {
        throw new HttpsError('internal', 'Password reset email is not configured.');
      }
      try {
        await sendPasswordResetEmailViaRest(cleanEmail, apiKey);
      } catch (emailErr) {
        throw new HttpsError('internal', 'Could not send the password link: ' + emailErr.message);
      }
      return { status: 'link_resent' };
    }

    // 2. Already has a pending request → don't create another
    const pending = await admin.firestore()
      .collection('accountRequests')
      .where('email', '==', cleanEmail)
      .where('status', '==', 'pending')
      .limit(1)
      .get();
    if (!pending.empty) {
      return { status: 'already_pending' };
    }

    // 3. New request
    await admin.firestore().collection('accountRequests').add({
      name:      cleanName,
      email:     cleanEmail,
      reason:    String(reason || '').trim(),
      status:    'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { status: 'submitted' };
  }
);

/**
 * createUserWithPassword
 *
 * Callable function (admin-only).
 *
 * Creates a Firebase Auth user with an admin-chosen password and the matching
 * Firestore profile doc. No email is sent — the admin shares the password.
 *
 * Called from the app with:
 *   httpsCallable(functions, 'createUserWithPassword')({ email, name, password })
 */
exports.createUserWithPassword = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in.');
  }

  const callerDoc = await admin.firestore()
    .collection('users')
    .doc(request.auth.uid)
    .get();

  if (!callerDoc.exists || callerDoc.data().admin !== true) {
    throw new HttpsError('permission-denied', 'Only admins can create users.');
  }

  const { email, name, password } = request.data || {};
  if (!email || !name || !password) {
    throw new HttpsError('invalid-argument', 'email, name, and password are required.');
  }
  if (String(password).length < 6) {
    throw new HttpsError('invalid-argument', 'Password must be at least 6 characters.');
  }

  let userRecord;
  try {
    userRecord = await admin.auth().createUser({
      email,
      displayName:   name,
      emailVerified: false,
      password:      String(password),
    });
  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      throw new HttpsError('already-exists', 'An account with this email already exists.');
    }
    if (err.code === 'auth/invalid-email') {
      throw new HttpsError('invalid-argument', 'Please enter a valid email address.');
    }
    throw new HttpsError('internal', 'Failed to create Auth user: ' + err.message);
  }

  await admin.firestore().collection('users').doc(userRecord.uid).set({
    email,
    name,
    meName:     name,
    wifeName:   'My Partner',
    properties: [],
    year:       String(new Date().getFullYear()),
    admin:      false,
    disabled:   false,
    createdAt:  admin.firestore.FieldValue.serverTimestamp(),
    createdBy:  request.auth.uid,
  }, { merge: true });

  return { success: true, uid: userRecord.uid };
});

/**
 * deleteUserAccount
 *
 * Callable function (admin-only).
 *
 * Flow:
 *  1. Verify the caller is an admin and is not deleting themselves.
 *  2. Delete all Firestore entries sub-collection docs (batched).
 *  3. Delete the Firestore user profile doc.
 *  4. Delete the Firebase Auth account.
 *
 * Called from the app with:
 *   httpsCallable(functions, 'deleteUserAccount')({ uid })
 */
exports.deleteUserAccount = onCall(async (request) => {
  // ── 1. Auth + safety checks ───────────────────────────────────────────────
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in.');
  }

  const callerDoc = await admin.firestore()
    .collection('users')
    .doc(request.auth.uid)
    .get();

  if (!callerDoc.exists || callerDoc.data().admin !== true) {
    throw new HttpsError('permission-denied', 'Only admins can delete accounts.');
  }

  const { uid } = request.data;
  if (!uid) {
    throw new HttpsError('invalid-argument', 'uid is required.');
  }
  if (uid === request.auth.uid) {
    throw new HttpsError('failed-precondition', 'You cannot delete your own account.');
  }

  // ── 2. Delete all entries (sub-collection) ────────────────────────────────
  const entriesRef = admin.firestore().collection('users').doc(uid).collection('entries');
  let snapshot;
  do {
    snapshot = await entriesRef.limit(400).get();
    if (!snapshot.empty) {
      const batch = admin.firestore().batch();
      snapshot.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  } while (!snapshot.empty);

  // ── 3. Delete the Firestore user profile doc ──────────────────────────────
  await admin.firestore().collection('users').doc(uid).delete();

  // ── 4. Delete the Firebase Auth account ───────────────────────────────────
  try {
    await admin.auth().deleteUser(uid);
  } catch (err) {
    if (err.code !== 'auth/user-not-found') {
      throw new HttpsError('internal', 'Firestore data deleted but Auth deletion failed: ' + err.message);
    }
    // auth/user-not-found is fine — Firestore data is already gone
  }

  return { success: true };
});

/**
 * sendPasswordResetEmailViaRest
 *
 * Calls the Firebase Identity Toolkit REST API to send a password-reset
 * ("set your password") email to the given address.
 *
 * @param {string} email   - recipient
 * @param {string} apiKey  - Firebase web API key
 */
function sendPasswordResetEmailViaRest(email, apiKey) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify({ requestType: 'PASSWORD_RESET', email });
    const options = {
      hostname: 'identitytoolkit.googleapis.com',
      path:     `/v1/accounts:sendOobCode?key=${apiKey}`,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(raw); } catch { json = {}; }
        if (json.error) reject(new Error(json.error.message));
        else            resolve(json);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
