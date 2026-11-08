// Example GatewayScript: get an OAuth token, call the backend (retrying once on 503),
// and map the response for the client. Runs unchanged on DataPower.
var urlopen = require('urlopen');
var hm = require('header-metadata');
var sm = require('service-metadata');
var cfg = require('local:///lib/config.js');

var log = console.options({ category: 'orders' });

function getToken(cb) {
  urlopen.open({
    target: cfg.tokenUrl,
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded',
    data: 'grant_type=client_credentials',
    sslClientProfile: 'backend-ssl',
    timeout: 10
  }, function (err, resp) {
    if (err) return cb(err);
    if (resp.statusCode !== 200) return cb(new Error('token endpoint returned ' + resp.statusCode));
    resp.readAsJSON(function (e, j) { cb(e, j && j.access_token); });
  });
}

function callBackend(token, body, attempt, cb) {
  urlopen.open({
    target: cfg.backendUrl + sm.URI,
    method: sm.protocolMethod,
    headers: { Authorization: 'Bearer ' + token, 'X-Correlation-Id': hm.current.get('X-Correlation-Id') },
    contentType: 'application/json',
    data: body,
    timeout: cfg.timeout
  }, function (err, resp) {
    if (err) return cb(err);
    if (resp.statusCode === 503 && attempt < 2) {
      log.warn('backend 503, retrying (attempt %d)', attempt);
      return callBackend(token, body, attempt + 1, cb);
    }
    cb(null, resp);
  });
}

session.input.readAsJSON(function (err, body) {
  if (err) { hm.response.statusCode = '400 Bad Request'; session.output.write({ error: 'invalid JSON' }); return; }
  getToken(function (err, token) {
    if (err) { session.reject('auth failed: ' + (err.errorMessage || err.message)); return; }
    callBackend(token, body, 1, function (err, resp) {
      if (err) {
        log.error('backend call failed: %s', err.errorMessage);
        hm.response.statusCode = '504 Gateway Timeout';
        session.output.write({ error: 'backend unavailable' });
        return;
      }
      resp.readAsJSON(function (e, data) {
        hm.response.statusCode = resp.statusCode;
        hm.response.set('Content-Type', 'application/json');
        sm.mpgw.skipBackside = true;
        session.output.write({ orderId: data.id, status: data.state });
      });
    });
  });
});
