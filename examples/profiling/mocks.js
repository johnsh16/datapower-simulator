// 2,000 orders, like a real backend: optional fields mean the objects
// don't all have the same shape.
module.exports = (gw) => {
  const orders = [];
  for (let i = 0; i < 2000; i++) {
    const o = { id: 1000 + i, sku: 'SKU-' + (i % 50), qty: 1 + (i % 7), price: 9.99 + (i % 13) };
    if (i % 3 === 0) o.coupon = 'SAVE' + (i % 10);
    if (i % 5 === 0) o.giftWrap = true;
    orders.push(o);
  }
  gw.urlopen.when({ method: 'GET', target: 'https://orders.example.com/orders*' }).reply(200, orders);
};
