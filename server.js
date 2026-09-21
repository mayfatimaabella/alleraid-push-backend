const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ============================================================
// FIREBASE ADMIN INITIALIZATION
// ============================================================

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error(
    'Missing FIREBASE_SERVICE_ACCOUNT environment variable'
  );
}

let serviceAccount;

try {
  serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT
  );
} catch (error) {
  console.error(
    'FIREBASE_SERVICE_ACCOUNT is not valid JSON:',
    error
  );

  throw new Error(
    'FIREBASE_SERVICE_ACCOUNT must contain valid JSON'
  );
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'AllerAid push backend is running'
  });
});

// ============================================================
// NORMALIZE FCM TOKENS
// ============================================================

function normalizeTokens(userData = {}) {
  const tokens = [];

  // pushTokens can be:
  //
  // [
  //   "token1",
  //   "token2"
  // ]
  //
  // OR
  //
  // [
  //   { token: "token1" },
  //   { token: "token2" }
  // ]

  if (Array.isArray(userData.pushTokens)) {
    userData.pushTokens.forEach((item) => {
      if (
        typeof item === 'string' &&
        item.trim()
      ) {
        tokens.push(item.trim());
      }

      if (
        item &&
        typeof item.token === 'string' &&
        item.token.trim()
      ) {
        tokens.push(item.token.trim());
      }
    });
  }

  // Support older/single-token format.
  if (
    typeof userData.fcmToken === 'string' &&
    userData.fcmToken.trim()
  ) {
    tokens.push(userData.fcmToken.trim());
  }

  // Remove duplicates.
  return [...new Set(tokens)];
}

// ============================================================
// SEND EMERGENCY PUSH
// ============================================================

app.post('/send-emergency-push', async (req, res) => {
  try {
    console.log(
      'Received emergency push request:',
      JSON.stringify(req.body, null, 2)
    );

    // IMPORTANT:
    // Your Angular service sends targetUserId.
    //
    // Do NOT use responderIds here.
    const {
      targetUserId,
      message
    } = req.body || {};

    
    // VALIDATE TARGET USER
    

    if (
      typeof targetUserId !== 'string' ||
      !targetUserId.trim()
    ) {
      return res.status(400).json({
        success: false,
        error: 'Missing targetUserId'
      });
    }

    const cleanTargetUserId =
      targetUserId.trim();

    
    // VALIDATE MESSAGE
    

    if (
      !message ||
      typeof message !== 'object'
    ) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid message'
      });
    }

    
    // FIND TARGET USER
    

    const userDoc = await db
      .collection('users')
      .doc(cleanTargetUserId)
      .get();

    if (!userDoc.exists) {
      console.error(
        'Target user not found:',
        cleanTargetUserId
      );

      return res.status(404).json({
        success: false,
        error: 'Target user not found',
        targetUserId: cleanTargetUserId
      });
    }

    const userData =
      userDoc.data() || {};

    
    // FIND FCM TOKENS
    

    const tokens =
      normalizeTokens(userData);

    console.log(
      'Target user:',
      cleanTargetUserId
    );

    console.log(
      'Resolved token count:',
      tokens.length
    );

    if (tokens.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No valid push tokens found for this user',
        targetUserId: cleanTargetUserId
      });
    }

    
    // BUILD FCM PAYLOAD
    

    const data =
      message.data || {};

    const payload = {
      notification: {
        title:
          String(
            message.title ||
            'EMERGENCY ALERT'
          ),

        body:
          String(
            message.body ||
            'A buddy needs immediate help!'
          )
      },

      data: {
        type:
          String(
            data.type ||
            'emergency'
          ),

        emergencyId:
          String(
            data.emergencyId ||
            ''
          ),

        patientName:
          String(
            data.patientName ||
            ''
          ),

        contactNumber:
          String(
            data.contactNumber ||
            ''
          ),

        dateOfBirth:
          String(
            data.dateOfBirth ||
            ''
          ),

        bloodType:
          String(
            data.bloodType ||
            ''
          ),

        gender:
          String(
            data.gender ||
            ''
          ),

        location:
          String(
            data.location ||
            ''
          ),

        allergies:
          String(
            data.allergies ||
            ''
          ),

        instructions:
          String(
            data.instructions ||
            ''
          ),

        profileDetails:
          String(
            data.profileDetails ||
            ''
          )
      },

      tokens
    };

    console.log(
      'Sending FCM multicast:',
      {
        tokenCount: tokens.length,
        title: payload.notification.title,
        body: payload.notification.body
      }
    );

    
    // SEND THROUGH FIREBASE CLOUD MESSAGING
    

    const response =
      await admin
        .messaging()
        .sendEachForMulticast(payload);

    
    // COLLECT FAILED TOKENS
    

    const failures =
      response.responses
        .map((result, index) => {
          if (result.success) {
            return null;
          }

          return {
            token: tokens[index],

            code:
              result.error?.code ||
              'unknown',

            message:
              result.error?.message ||
              'Unknown FCM error'
          };
        })
        .filter(Boolean);

    
    // LOG RESULT
    

    console.log(
      'FCM result:',
      {
        sent: response.successCount,
        failed: response.failureCount,
        total: tokens.length
      }
    );

    if (failures.length > 0) {
      console.warn(
        'FCM failures:',
        failures
      );
    }

    
    // RETURN RESULT TO ANGULAR
    

    return res.status(200).json({
      success:
        response.successCount > 0,

      sent:
        response.successCount,

      failed:
        response.failureCount,

      total:
        tokens.length,

      failures
    });

  } catch (error) {
    console.error(
      'Emergency push error:',
      error
    );

    return res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : String(error)
    });
  }
});

// ============================================================
// REVERSE GEOCODING
// LOCATIONIQ
// ============================================================

// Simple in-memory cache.
//
// This is reset whenever the server restarts.
// For multiple backend instances, use Redis/Firestore/etc.

const geocodeCache = new Map();

app.get('/reverse-geocode', async (req, res) => {
  try {
    const {
      lat,
      lon
    } = req.query;

    
    // VALIDATE PARAMETERS
    

    if (
      lat === undefined ||
      lon === undefined
    ) {
      return res.status(400).json({
        success: false,
        error:
          'Missing lat or lon query parameter'
      });
    }

    const latNum =
      Number.parseFloat(lat);

    const lonNum =
      Number.parseFloat(lon);

    if (
      !Number.isFinite(latNum) ||
      !Number.isFinite(lonNum)
    ) {
      return res.status(400).json({
        success: false,
        error:
          'lat and lon must be valid numbers'
      });
    }

    
    // CHECK LOCATIONIQ TOKEN
    

    if (
      !process.env.LOCATIONIQ_TOKEN
    ) {
      return res.status(500).json({
        success: false,
        error:
          'Missing LOCATIONIQ_TOKEN environment variable'
      });
    }

    
    // CACHE KEY
    

    const key =
      `${latNum.toFixed(5)},${lonNum.toFixed(5)}`;

    if (
      geocodeCache.has(key)
    ) {
      return res.json({
        success: true,
        address:
          geocodeCache.get(key),
        cached: true
      });
    }

    
    // LOCATIONIQ REQUEST
    

    const url =
      'https://us1.locationiq.com/v1/reverse' +
      `?key=${encodeURIComponent(
        process.env.LOCATIONIQ_TOKEN
      )}` +
      `&lat=${encodeURIComponent(
        latNum
      )}` +
      `&lon=${encodeURIComponent(
        lonNum
      )}` +
      '&format=json';

    console.log(
      'Reverse geocoding:',
      latNum,
      lonNum
    );

    const response =
      await fetch(url, {
        headers: {
          'User-Agent':
            'AllerAid/1.0 (contact: mayfatimabella@gmail.com)',
          'Accept':
            'application/json'
        }
      });

    if (!response.ok) {
      const errorText =
        await response.text();

      throw new Error(
        `LocationIQ responded with HTTP ${response.status}: ${errorText}`
      );
    }

    const data =
      await response.json();

    const address =
      typeof data?.display_name === 'string'
        ? data.display_name
        : null;

    
    // CACHE RESULT
    

    if (address) {
      geocodeCache.set(
        key,
        address
      );
    }

    return res.json({
      success: true,
      address,
      cached: false
    });

  } catch (error) {
    console.error(
      'Reverse geocode error:',
      error
    );

    return res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : String(error)
    });
  }
});

// ============================================================
// 404 HANDLER
// ============================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.path
  });
});

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use((error, req, res, next) => {
  console.error(
    'Unhandled server error:',
    error
  );

  res.status(500).json({
    success: false,
    error:
      error instanceof Error
        ? error.message
        : String(error)
  });
});

// ============================================================
// START SERVER
// ============================================================

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `AllerAid push backend running on port ${PORT}`
  );
});
