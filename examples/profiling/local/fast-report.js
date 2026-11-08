// Profiling example: the same CSV export as slow-report.js, following the checklist.
var urlopen = require('urlopen');
var hm = require('header-metadata');

function toRow(o) {
  return o.id + ',' + o.sku + ',' + o.qty + ',' + (o.qty * o.price).toFixed(2);
}

session.input.readAsJSON(function (err, req) {               // input read once
  if (err) {
    hm.response.statusCode = 400;
    session.output.write('invalid request');
    return;
  }
  urlopen.open({
    target: 'https://orders.example.com/orders?since=' + req.since,
    method: 'GET',
    timeout: 5                                                // bounded wait
  }, function (e, resp) {
    if (e) {
      hm.response.statusCode = 504;
      session.output.write('orders service unavailable');
      return;
    }
    resp.readAsJSON(function (e2, orders) {
      var rows = ['id,sku,qty,total'];
      for (var i = 0; i < orders.length; i++) rows.push(toRow(orders[i]));   // no copies
      hm.response.set('Content-Type', 'text/csv');
      session.output.write(rows.join('\n') + '\n');           // output written once
    });
  });
});
