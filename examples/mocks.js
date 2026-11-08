// Mocks for: node bin/gws-run.js examples/local/orchestrate.js --mocks examples/mocks.js ...
module.exports = (gw) => {
  gw.urlopen
    .when({ method: 'POST', target: 'https://auth.example.com/oauth2/token' }).reply(200, { access_token: 'abc' })
    .when('https://orders.example.com/*').delay(10000).reply(200); // longer than the 5s timeout -> 504 path
};
