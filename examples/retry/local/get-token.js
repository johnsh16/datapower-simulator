// Retry example: get a token, calling the endpoint up to 3 times until one is valid.
// Used by templates/retry.test.js. Same shape as a roster-processing token retrieve.
var urlopen = require('urlopen')
var hm = require('header-metadata')

var TOKEN_URL = 'https://auth.example.com/token'
var MAX_ATTEMPTS = 3

// One call to the endpoint: resolves the token, or rejects.
function requestToken () {
  return new Promise(function (resolve, reject) {
    urlopen.open({ target: TOKEN_URL, method: 'POST', data: 'grant_type=client_credentials', timeout: 5 }, function (err, resp) {
      if (err) return reject(err)
      resp.readAsJSON(function (e, body) {
        if (e || resp.statusCode !== 200 || !body || !body.access_token) return reject(new Error('invalid token response'))
        resolve(body.access_token)
      })
    })
  })
}

async function getTokenWithRetry (retryLimit, tokenFunction) {
  for (var attempt = 1; attempt <= retryLimit; attempt++) {
    try {
      var token = await tokenFunction()
      if (token) return token
    } catch (e) {
      console.warn('Token attempt ' + attempt + ' failed: ' + (e.errorMessage || e.message))
    }
  }
  throw new Error('No valid token after ' + retryLimit + ' attempts')
}

session.input.readAsJSON(async function (err) {
  if (err) {
    hm.response.statusCode = 400
    session.output.write({ error: 'request body is not valid JSON' })
    return
  }
  try {
    session.output.write(await getTokenWithRetry(MAX_ATTEMPTS, requestToken))
  } catch (e) {
    hm.response.statusCode = 502
    session.output.write({ error: e.message })
  }
})
