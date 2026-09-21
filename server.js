const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));


// FIREBASE ADMIN


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
  throw new Error(
    'FIREBASE_SERVICE_ACCOUNT is not valid JSON'
  );
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();


// HEALTH CHECK


app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'AllerAid push backend is running'
  });
});


// NORMALIZE FCM TOKENS


function normalizeTokens(userData = {}) {
  const tokens = [];

  // pushTokens can be:
  //
  // [
  //   "token1",
  //   "token2"
  // ]
  //
  // OR:
  //
  // [
  //   { token: "token1" },
  //   { token: "token2" }
  // ]

  if (Array.isArray(userData.pushTokens)) {
    userData.pushTokens.forEach(item => {
      if (typeof item === 'string') {
        const token = item.trim();

        if (token) {
          tokens.push(token);
        }
      }

      if (
        item &&
        typeof item.token === 'string'
      ) {
        const token = item.token.trim();

        if (token) {
          tokens.push(token);
        }
      }
    });
  }

  // Legacy/single token support
  if (
    typeof userData.fcmToken === 'string' &&
    userData.fcmToken.trim()
  ) {
    tokens.push(
      userData.fcmToken.trim()
    );
  }

  return [
    ...new Set(
      tokens.filter(Boolean)
    )
  ];
}


// SEND EMERGENCY PUSH


app.post(
  '/send-emergency-push',
  async (req, res) => {
    try {


      console.log(
        'Received emergency push request:'
      );

      console.log(
        JSON.stringify(
          req.body,
          null,
          2
        )
      );

      const {
        targetUserId,
        responderIds,
        message
      } = req.body;

      
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

      
      // VALIDATE MESSAGE
      

      if (
        !message ||
        typeof message !== 'object'
      ) {
        return res.status(400).json({
          success: false,
          error: 'Missing message'
        });
      }

      const cleanTargetUserId =
        targetUserId.trim();

      
      // GET USER
      

      const userRef =
        db
          .collection('users')
          .doc(cleanTargetUserId);

      const userDoc =
        await userRef.get();

      if (!userDoc.exists) {
        return res.status(404).json({
          success: false,
          error: 'Target user not found',
          targetUserId: cleanTargetUserId
        });
      }

      const userData =
        userDoc.data() || {};

      
      // GET FCM TOKENS
      

      const tokens =
        normalizeTokens(userData);

      console.log(
        'Target user:',
        cleanTargetUserId
      );

      console.log(
        'Resolved FCM token count:',
        tokens.length
      );

      if (tokens.length === 0) {
        return res.status(404).json({
          success: false,
          error:
            'No valid push tokens found for this user',
          targetUserId:
            cleanTargetUserId
        });
      }

      
      // CREATE FCM PAYLOAD
      

      const title =
        typeof message.title === 'string' &&
        message.title.trim()
          ? message.title.trim()
          : 'Emergency Alert';

      const body =
        typeof message.body === 'string' &&
        message.body.trim()
          ? message.body.trim()
          : 'A buddy needs emergency assistance.';

      const messageData =
        message.data &&
        typeof message.data === 'object'
          ? message.data
          : {};

      const payload = {
        notification: {
          title,
          body
        },

        data: {
          type: String(
            messageData.type ||
            'emergency'
          ),

          emergencyId: String(
            messageData.emergencyId ||
            ''
          ),

          patientName: String(
            messageData.patientName ||
            ''
          ),

          allergies: String(
            messageData.allergies ||
            ''
          ),

          instructions: String(
            messageData.instructions ||
            ''
          ),

          location: String(
            messageData.location ||
            ''
          ),

          profileDetails: String(
            messageData.profileDetails ||
            ''
          )
        },

        tokens
      };

      console.log(
        'Sending FCM notification:',
        JSON.stringify(
          {
            title,
            body,
            tokenCount: tokens.length
          },
          null,
          2
        )
      );

      
      // SEND FCM
      

      const response =
        await admin
          .messaging()
          .sendEachForMulticast(
            payload
          );

      
      // PROCESS FAILURES
      

      const failures =
        response.responses
          .map(
            (result, index) => {
              if (result.success) {
                return null;
              }

              return {
                token:
                  tokens[index],

                code:
                  result.error?.code ||
                  'unknown',

                message:
                  result.error?.message ||
                  'Unknown FCM error'
              };
            }
          )
          .filter(Boolean);

      
      // REMOVE INVALID TOKENS
      

      const invalidTokenCodes = new Set([
        'messaging/invalid-registration-token',
        'messaging/registration-token-not-registered'
      ]);

      const invalidTokens =
        response.responses
          .map(
            (result, index) => {
              if (
                result.success ||
                !result.error
              ) {
                return null;
              }

              if (
                invalidTokenCodes.has(
                  result.error.code
                )
              ) {
                return tokens[index];
              }

              return null;
            }
          )
          .filter(Boolean);

      if (
        invalidTokens.length > 0
      ) {
        console.log(
          'Invalid FCM tokens:',
          invalidTokens.length
        );

        const currentPushTokens =
          Array.isArray(
            userData.pushTokens
          )
            ? userData.pushTokens
            : [];

        const cleanedTokens =
          currentPushTokens.filter(
            item => {
              const token =
                typeof item === 'string'
                  ? item
                  : item?.token;

              return (
                typeof token !== 'string' ||
                !invalidTokens.includes(
                  token
                )
              );
            }
          );

        try {
          await userRef.update({
            pushTokens:
              cleanedTokens
          });
        } catch (cleanupError) {
          console.warn(
            'Could not clean invalid FCM tokens:',
            cleanupError
          );
        }
      }

      
      // LOG RESULT
      

      console.log(
        'FCM result:',
        {
          sent:
            response.successCount,

          failed:
            response.failureCount,

          failures
        }
      );

      console.log(
        'Responder IDs:',
        responderIds || []
      );

      
      // RESPONSE
      

      return res.json({
        success:
          response.successCount > 0,

        sent:
          response.successCount,

        failed:
          response.failureCount,

        targetUserId:
          cleanTargetUserId,

        failures
      });

    } catch (error) {
      console.error(
        '======================================'
      );

      console.error(
        'Push error:',
        error
      );

      console.error(
        '======================================'
      );

      return res.status(500).json({
        success: false,
        error:
          error?.message ||
          'Internal server error'
      });
    }
  }
);


// LOCATIONIQ REVERSE GEOCODING


const geocodeCache =
  new Map();

app.get(
  '/reverse-geocode',
  async (req, res) => {
    try {
      const {
        lat,
        lon
      } = req.query;

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
        Number(lat);

      const lonNum =
        Number(lon);

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

      if (
        latNum < -90 ||
        latNum > 90 ||
        lonNum < -180 ||
        lonNum > 180
      ) {
        return res.status(400).json({
          success: false,
          error:
            'Invalid latitude or longitude'
        });
      }

      if (
        !process.env.LOCATIONIQ_TOKEN
      ) {
        return res.status(500).json({
          success: false,
          error:
            'Missing LOCATIONIQ_TOKEN environment variable'
        });
      }

      // Reduce GPS jitter
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

      const response =
        await fetch(
          url,
          {
            headers: {
              'User-Agent':
                'AllerAid/1.0 (contact: mayfatimabella@gmail.com)',
              'Accept':
                'application/json'
            }
          }
        );

      if (!response.ok) {
        const responseText =
          await response.text();

        throw new Error(
          `LocationIQ responded with HTTP ${response.status}: ${responseText}`
        );
      }

      const data =
        await response.json();

      const address =
        typeof data?.display_name ===
        'string'
          ? data.display_name
          : null;

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
          error?.message ||
          'Reverse geocoding failed'
      });
    }
  }
);


// 404


app.use(
  (req, res) => {
    res.status(404).json({
      success: false,
      error: 'Endpoint not found'
    });
  }
);


// ERROR HANDLER


app.use(
  (error, req, res, next) => {
    console.error(
      'Unhandled Express error:',
      error
    );

    res.status(500).json({
      success: false,
      error:
        error?.message ||
        'Internal server error'
    });
  }
);


// START SERVER


const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  () => {
    console.log(
      `AllerAid push backend running on port ${PORT}`
    );
  }
);
