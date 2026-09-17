const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error('Missing FIREBASE_SERVICE_ACCOUNT environment variable');
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

app.get('/', (req, res) => {
  res.send('AllerAid push backend is running');
});

function normalizeTokens(userData) {
  const tokens = [];

  if (Array.isArray(userData.pushTokens)) {
    userData.pushTokens.forEach(item => {
      if (typeof item === 'string') {
        tokens.push(item);
      }

      if (item && typeof item.token === 'string') {
        tokens.push(item.token);
      }
    });
  }

  if (typeof userData.fcmToken === 'string' && userData.fcmToken.trim()) {
    tokens.push(userData.fcmToken);
  }

  return [...new Set(tokens.filter(Boolean))];
}

app.post('/send-emergency-push', async (req, res) => {
  try {
    console.log('Received push request:', JSON.stringify(req.body, null, 2));

    const { targetUserId, message } = req.body;

    if (!targetUserId) {
      return res.status(400).json({
        success: false,
        error: 'Missing targetUserId'
      });
    }

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Missing message'
      });
    }

    const userDoc = await db.collection('users').doc(targetUserId).get();

    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Target user not found',
        targetUserId
      });
    }

    const userData = userDoc.data();
    const tokens = normalizeTokens(userData);

    console.log('Target user:', targetUserId);
    console.log('Resolved token count:', tokens.length);

    if (!tokens.length) {
      return res.status(404).json({
        success: false,
        error: 'No valid push tokens found for this user',
        targetUserId
      });
    }

    const payload = {
      notification: {
        title: message.title || 'Emergency Alert',
        body: message.body || 'A buddy needs emergency assistance.'
      },
      data: {
        type: String(message.data?.type || 'emergency'),
        emergencyId: String(message.data?.emergencyId || ''),
        patientName: String(message.data?.patientName || ''),
        allergies: String(message.data?.allergies || ''),
        instructions: String(message.data?.instructions || ''),
        location: String(message.data?.location || ''),
        profileDetails: String(message.data?.profileDetails || '')
      },
      tokens
    };

    const response = await admin.messaging().sendEachForMulticast(payload);

    const failures = response.responses
      .map((result, index) => {
        if (result.success) return null;

        return {
          token: tokens[index],
          code: result.error?.code,
          message: result.error?.message
        };
      })
      .filter(Boolean);

    console.log('FCM result:', {
      sent: response.successCount,
      failed: response.failureCount,
      failures
    });

    return res.json({
      success: response.successCount > 0,
      sent: response.successCount,
      failed: response.failureCount,
      failures
    });

  } catch (error) {
    console.error('Push error:', error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================
// REVERSE GEOCODING PROXY (LocationIQ)
// ============================

// Simple in-memory cache to avoid excess API calls.
// Note: this resets on server restart and isn't shared across instances.
const geocodeCache = new Map();

app.get('/reverse-geocode', async (req, res) => {
  try {
    const { lat, lon } = req.query;

    if (!lat || !lon) {
      return res.status(400).json({
        success: false,
        error: 'Missing lat or lon query parameter'
      });
    }

    const latNum = parseFloat(lat);
    const lonNum = parseFloat(lon);

    if (Number.isNaN(latNum) || Number.isNaN(lonNum)) {
      return res.status(400).json({
        success: false,
        error: 'lat and lon must be valid numbers'
      });
    }

    if (!process.env.LOCATIONIQ_TOKEN) {
      return res.status(500).json({
        success: false,
        error: 'Missing LOCATIONIQ_TOKEN environment variable'
      });
    }

    // Round to reduce cache fragmentation from tiny GPS jitter
    const key = `${latNum.toFixed(5)},${lonNum.toFixed(5)}`;

    if (geocodeCache.has(key)) {
      return res.json({
        success: true,
        address: geocodeCache.get(key),
        cached: true
      });
    }

    const url = `https://us1.locationiq.com/v1/reverse?key=${process.env.LOCATIONIQ_TOKEN}&lat=${encodeURIComponent(latNum)}&lon=${encodeURIComponent(lonNum)}&format=json`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'AllerAid/1.0 (contact: mayfatimabella@gmail.com)'
      }
    });

    if (!response.ok) {
      throw new Error(`LocationIQ responded with HTTP ${response.status}`);
    }

    const data = await response.json();
    const address = data?.display_name || null;

    if (address) {
      geocodeCache.set(key, address);
    }

    return res.json({ success: true, address, cached: false });

  } catch (error) {
    console.error('Reverse geocode error:', error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`AllerAid push backend running on port ${PORT}`);
});

//$env:FIREBASE_SERVICE_ACCOUNT = Get-Content .\serviceAccountKey.json -Raw
//>> npm start