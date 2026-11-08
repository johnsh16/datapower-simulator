// Profiling example: export recent orders as CSV.
// It works, but it breaks several rules from the performance checklist on purpose.
// Compare with fast-report.js, which produces the same CSV.
var urlopen = require('urlopen');

function toRow(o) {
  return o.id + ',' + o.sku + ',' + o.qty + ',' + (o.qty * o.price).toFixed(2);
}

session.input.readAsJSON(function (err, req) {
  session.input.readAsBuffer(function (err2, raw) {          // reads the input a second time
    console.debug('request was ' + raw.length + ' bytes');
    urlopen.open({                                            // no timeout option
      target: 'https://orders.example.com/orders?since=' + req.since,
      method: 'GET'
    }, function (e, resp) {
      resp.readAsJSON(function (e2, orders) {
        var util = require('util');                           // require() inside a callback
        var csv = '';
        for (var i = 0; i < orders.length; i++) {
          var o = JSON.parse(JSON.stringify(orders[i]));      // deep copy of every order
          if (o.coupon) delete o.coupon;                      // changes the object's shape
          csv += toRow(o) + '\n';
        }
        var audit = session.name('audit') || session.createContext('audit');
        audit.setVariable('orders', orders);                  // keeps the whole payload around
        session.output.write('id,sku,qty,total\n');           // first write...
        session.output.write('id,sku,qty,total\n' + csv);     // ...replaced by the second
      });
    });
  });
});
