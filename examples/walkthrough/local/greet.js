// Walkthrough example: look up a user's profile and return a greeting.
// Request body: { "name": "ada" }
var urlopen = require('urlopen');
var hm = require('header-metadata');
var sm = require('service-metadata');

session.input.readAsJSON(function (err, req) {
  if (err || !req || !req.name) {
    hm.response.statusCode = '400 Bad Request';
    session.output.write({ error: 'body must be JSON with a "name" field' });
    return;
  }

  urlopen.open({
    target: 'https://profiles.example.com/users/' + encodeURIComponent(req.name),
    method: 'GET',
    headers: { 'X-Correlation-Id': hm.current.get('X-Correlation-Id') || 'none' },
    timeout: 5
  }, function (err, resp) {
    if (err) {
      console.error('profile service unreachable: %s', err.errorMessage);
      hm.response.statusCode = '502 Bad Gateway';
      session.output.write({ error: 'profile service unavailable' });
      return;
    }
    if (resp.statusCode === 404) {
      hm.response.statusCode = '404 Not Found';
      session.output.write({ error: 'no such user' });
      return;
    }
    resp.readAsJSON(function (err, profile) {
      if (err) {
        console.error('profile service sent invalid JSON: %s', err.errorMessage);
        hm.response.statusCode = '502 Bad Gateway';
        session.output.write({ error: 'profile service unavailable' });
        return;
      }
      hm.response.set('Content-Type', 'application/json');
      sm.mpgw.skipBackside = true;
      session.output.write({ message: 'Hello, ' + profile.displayName + '!' });
    });
  });
});
