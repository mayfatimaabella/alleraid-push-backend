const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));


// FIREBASE INITIALIZATION


if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error(
    'Missing FIREBASE_SERVICE_ACCOUNT environment variable'
  );
}

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();



// HEALTH CHECK


app.get('/', (req, res) => {
  res.send('AllerAid push backend is running');
});



// FCM TOKEN NORMALIZATION


function normalizeTokens(userData) {
  const tokens = [];

  // New format:
  // pushTokens: ['token1', 'token2']

  if (Array.isArray(userData.pushTokens)) {
    userData.pushTokens.forEach(item => {
      if (typeof item === 'string') {
        tokens.push(item);
      }

      // Also support:
      // pushTokens: [{ token: 'token1' }]

      if (
        item &&
        typeof item.token === 'string'
      ) {
        tokens.push(item.token);
      }
    });
  }

  // Backwards compatibility:
  // fcmToken: 'token'

  if (
    typeof userData.fcmToken === 'string' &&
    userData.fcmToken.trim()
  ) {
    tokens.push(userData.fcmToken);
  }

  return [
    ...new Set(
      tokens
        .map(token => token.trim())
        .filter(Boolean)
    )
  ];
}



// SEND EMERGENCY PUSH TO RESPONDERS


app.post('/send-emergency-push', async (req, res) => {
  try {
    console.log(
      'Received push request:',
      JSON.stringify(req.body, null, 2)
    );

    const {
      responderIds,
      message
    } = req.body;


    
    // VALIDATE RESPONDER IDS
    

    if (
      !Array.isArray(responderIds) ||
      responderIds.length === 0
    ) {
      return res.status(400).json({
        success: false,
        error: 'Missing responderIds'
      });
    }


    // Remove invalid and duplicate IDs

    const uniqueResponderIds = [
      ...new Set(
        responderIds.filter(
          id =>
            typeof id === 'string' &&
            id.trim().length > 0
        )
      )
    ];


    if (uniqueResponderIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid responder IDs provided'
      });
    }


    
    // VALIDATE MESSAGE
    

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Missing message'
      });
    }


    console.log(
      'Target responder IDs:',
      uniqueResponderIds
    );


    
    // GET RESPONDER DOCUMENTS
    

    const responderDocs = await Promise.all(
      uniqueResponderIds.map(responderId =>
        db
          .collection('users')
          .doc(responderId)
          .get()
      )
    );


    
    // COLLECT FCM TOKENS
    

    const allTokens = [];

    const respondersFound = [];

    const respondersNotFound = [];

    const respondersWithoutTokens = [];


    for (let i = 0; i < responderDocs.length; i++) {

      const responderDoc = responderDocs[i];

      const responderId =
        uniqueResponderIds[i];


      // Responder does not exist

      if (!responderDoc.exists) {

        console.warn(
          `Responder not found: ${responderId}`
        );

        respondersNotFound.push(
          responderId
        );

        continue;
      }


      respondersFound.push(
        responderId
      );


      const userData =
        responderDoc.data();


      const responderTokens =
        normalizeTokens(userData);


      console.log(
        `Responder ${responderId} has ${responderTokens.length} push token(s)`
      );


      if (responderTokens.length === 0) {

        respondersWithoutTokens.push(
          responderId
        );

        continue;
      }


      allTokens.push(
        ...responderTokens
      );
    }


    // Remove duplicate FCM tokens

    const tokens = [
      ...new Set(allTokens)
    ];


    console.log(
      'Total unique FCM tokens:',
      tokens.length
    );


    
    // NO TOKENS FOUND
    

    if (tokens.length === 0) {

      return res.status(404).json({
        success: false,

        error:
          'No valid push tokens found for the specified responders',

        respondersFound,

        respondersNotFound,

        respondersWithoutTokens
      });
    }


    
    // CREATE FCM PAYLOAD
    

    const payload = {

      notification: {

        title:
          message.title ||
          'EMERGENCY ALERT',

        body:
          message.body ||
          'A buddy needs emergency assistance.'
      },


      data: {

        type:
          String(
            message.data?.type ||
            'emergency'
          ),

        emergencyId:
          String(
            message.data?.emergencyId ||
            ''
          ),

        patientName:
          String(
            message.data?.patientName ||
            ''
          ),

        allergies:
          String(
            message.data?.allergies ||
            ''
          ),

        instructions:
          String(
            message.data?.instructions ||
            ''
          ),

        location:
          String(
            message.data?.location ||
            ''
          ),

        profileDetails:
          String(
            message.data?.profileDetails ||
            ''
          )
      },


      tokens
    };


    console.log(
      'Sending FCM notification to',
      tokens.length,
      'device(s)'
    );


    
    // SEND FCM NOTIFICATION
    

    const response =
      await admin
        .messaging()
        .sendEachForMulticast(payload);


    
    // HANDLE FAILED TOKENS
    

    const failures =
      response.responses
        .map((result, index) => {

          if (result.success) {
            return null;
          }


          return {

            token:
              tokens[index],

            code:
              result.error?.code ||
              null,

            message:
              result.error?.message ||
              null
          };
        })
        .filter(Boolean);


    
    // LOG RESULT
    

    console.log(
      'FCM result:',
      {
        sent:
          response.successCount,

        failed:
          response.failureCount,

        respondersFound,

        respondersNotFound,

        respondersWithoutTokens,

        failures
      }
    );


    
    // RESPONSE TO ANGULAR
    

    return res.json({

      success:
        response.successCount > 0,

      sent:
        response.successCount,

      failed:
        response.failureCount,

      respondersFound,

      respondersNotFound,

      respondersWithoutTokens,

      failures
    });


  } catch (error) {

    console.error(
      'Push error:',
      error
    );


    return res.status(500).json({

      success: false,

      error:
        error.message
    });
  }
});



// REVERSE GEOCODING PROXY
// LOCATIONIQ


// Simple in-memory cache.
// This resets when the server restarts.

const geocodeCache =
  new Map();


app.get('/reverse-geocode', async (req, res) => {

  try {

    const {
      lat,
      lon
    } = req.query;


    
    // VALIDATE PARAMETERS
    

    if (!lat || !lon) {

      return res.status(400).json({

        success: false,

        error:
          'Missing lat or lon query parameter'
      });
    }


    const latNum =
      parseFloat(lat);

    const lonNum =
      parseFloat(lon);


    if (
      Number.isNaN(latNum) ||
      Number.isNaN(lonNum)
    ) {

      return res.status(400).json({

        success: false,

        error:
          'lat and lon must be valid numbers'
      });
    }


    
    // LOCATIONIQ TOKEN
    

    if (!process.env.LOCATIONIQ_TOKEN) {

      return res.status(500).json({

        success: false,

        error:
          'Missing LOCATIONIQ_TOKEN environment variable'
      });
    }


    
    // CACHE KEY
    

    const key =
      `${latNum.toFixed(5)},${lonNum.toFixed(5)}`;


    
    // RETURN CACHED ADDRESS
    

    if (geocodeCache.has(key)) {

      return res.json({

        success: true,

        address:
          geocodeCache.get(key),

        cached: true
      });
    }


    
    // LOCATIONIQ REQUEST
    

    const url =
      `https://us1.locationiq.com/v1/reverse` +
      `?key=${process.env.LOCATIONIQ_TOKEN}` +
      `&lat=${encodeURIComponent(latNum)}` +
      `&lon=${encodeURIComponent(lonNum)}` +
      `&format=json`;


    const response =
      await fetch(url, {

        headers: {

          'User-Agent':
            'AllerAid/1.0 (contact: mayfatimabella@gmail.com)'
        }
      });


    if (!response.ok) {

      throw new Error(
        `LocationIQ responded with HTTP ${response.status}`
      );
    }


    const data =
      await response.json();


    const address =
      data?.display_name ||
      null;


    
    // CACHE ADDRESS
    

    if (address) {

      geocodeCache.set(
        key,
        address
      );
    }


    
    // RESPONSE
    

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
        error.message
    });
  }
});



// START SERVER


const PORT =
  process.env.PORT || 3000;


app.listen(PORT, () => {

  console.log(
    `AllerAid push backend running on port ${PORT}`
  );
});



// LOCAL DEVELOPMENT

//
// PowerShell:
//
// $env:FIREBASE_SERVICE_ACCOUNT =
//   Get-Content .\serviceAccountKey.json -Raw
//
// npm start
//

