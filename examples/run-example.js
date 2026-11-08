// node examples/run-example.js
const path = require('path');
const { Gateway } = require('..');

(async () => {
  const gw = new Gateway({ localDir: path.join(__dirname, 'local'), printLogs: 'info' });

  gw.urlopen
    .when({ method: 'POST', target: 'https://auth.example.com/oauth2/token' })
      .reply(200, { access_token: 'abc123', expires_in: 3600 })
    .when({ target: 'https://orders.example.com/orders' }).replyOnce(503, 'busy')
    .when({ target: 'https://orders.example.com/orders', headers: { authorization: 'Bearer abc123' } })
      .reply((req) => ({ statusCode: 201, body: { id: 'ORD-1', state: 'NEW', echo: req.json() } }));

  const res = await gw.run('local:///orchestrate.js', {
    input: { sku: 'X1', qty: 2 },
    headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': 'corr-9' },
    serviceVars: { 'var://service/URI': '/orders', 'var://service/protocol-method': 'POST' },
  });

  console.log('\nstatus :', res.statusCode, res.reasonPhrase);
  console.log('headers:', res.headers.response);
  console.log('body   :', res.output.json());
  console.log('calls  :', res.urlopenCalls.map((c) => `${c.method} ${c.target} -> ${c.response && c.response.statusCode}`));
})();
