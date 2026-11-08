# What GatewayScript can `require()`

GatewayScript looks like Node.js but is not Node.js. A script can only load DataPower's own modules, a small set of Node-compatible ones, and its own CommonJS files from `local:///` or `store:///`. This page records what DataPower provides, how sure we are, and what the simulator does for each. It targets the **10.5.0 LTS stream** (checked against a user running IDG.10.5.0.19).

IBM's GatewayScript reference on ibm.com/docs is the authority, but its pages couldn't be loaded when this was written (they render in the browser). The findings below come from the sources listed at the end. Where they leave a gap, it's marked rather than guessed.

**Confidence levels**

- **Documented**: named with its functions by an IBM page or IBM-published material.
- **Named**: IBM docs name the module, but the functions weren't available.
- **Not found**: in no source consulted. It may still exist; treat code that relies on it as unverified until you try it on the appliance.

## Global objects

Available without `require`: `session`, `console`, `XML` (`parse`, `stringify`), `Buffer`, `Buffers`, plus context objects and error objects. All are documented, and all are emulated.

## DataPower modules

| `require(...)` | Status | Simulator |
|---|---|---|
| `fs` | Documented | **Emulated** (see below) |
| `urlopen` | Documented | Emulated, with mockable backends |
| `header-metadata` | Documented | Emulated |
| `service-metadata` | Documented | Emulated, including camelCase properties |
| `system-metadata` | Seen in community code (`getVariable`, `setVariable`) | Emulated: `getVar`, `setVar`, `getVariable`, `setVariable`, `list` |
| `console` | Documented (also a global) | Emulated |
| `transform` | Documented (`xpath`, `xslt`) | XPath real; XSLT/XQuery results you register |
| `multistep` | Named | `callRule` runs rules you register |
| `crypto` | Documented (a subset of Node's: hash, hmac, sign/verify, cipher/decipher, randomBytes) | Node's crypto, with `name:key` references |
| `jwt` | Documented (`Encoder`, `Decoder`) | Approximation, JWS only |
| `jose` | Documented | Loads; calls explain it isn't emulated |
| `jwk` | Documented | Loads; calls explain it isn't emulated |
| `sprintf` | Documented (IBM playground docs, used in IBM samples) | **Emulated** |
| `apim` | Documented (API Connect) | Emulated |
| `apigw` | Named | Loads; calls explain it isn't emulated |
| `ratelimit` | Named | Loads; calls explain it isn't emulated |
| `json-xml-converter` | Named | Loads; calls explain it isn't emulated |
| `mgmt` | Named (as unavailable in API Connect's assembly action) | Loads; calls explain it isn't emulated |
| `policy-utility` | Documented (cheat sheet: `require('policy/policy-utility.js')`) | Loads under both names; calls explain it isn't emulated |

## Node.js-compatible modules

| `require(...)` | Status | Simulator |
|---|---|---|
| `assert` | Documented | Node's `assert` |
| `punycode` | Documented | Node's `punycode` |
| `querystring` | Documented (`escape`, `parse`, `stringify`, `unescape`) | Node's `querystring` |
| `url` | Documented (`parse`, `format`) | Node's `url` |
| `util` | Documented (`format`, `inherits`, `inspect`, `isArray`, `isDate`, `isError`, `isRegExp`, `isNode`, `isNodeList`, `isNamedNodeMap`, `safeTypeOf`) | The documented set. `safeTypeOf` throws, since its behaviour isn't described. Other Node `util` functions work **with a warning** |
| `buffer`, `events`, `path`, `string_decoder`, `zlib` | **Not found** | Load **with a warning** |
| `http`, `https`, `net`, `child_process`, `os`, `stream`, ... | Not found; use `urlopen` for HTTP | Not available |
| npm packages | Not available: scripts can only load CommonJS files you put on the appliance | Refused unless `allowNodeModules: true` |

"With a warning" means the script still runs, and the run's log gets a `gws-sim` warning such as *"require('path'): this Node module isn't listed in DataPower's GatewayScript documentation; it works here but may not on the appliance."* That way a passing test doesn't hide a dependency the appliance may not satisfy.

## The `fs` module

DataPower's `fs` is its own module, **not Node's**. There's no `readFileSync`, no streams, and files are named by DataPower URL.

| Function | Simulator behaviour |
|---|---|
| `readFile(file, [encoding], cb)` | `cb(err, Buffer)`, or a string when an encoding is given |
| `readAsJSON(file, cb)` / `readAsXML(file, cb)` | Parsed JSON / XML Document |
| `exists(file, cb)` | `cb(true/false)`; a callback with two parameters gets `(err, exists)` |
| `writeFile(file, data, cb)` | Creates or replaces the file |
| `appendFile(file, data, cb)` | Appends, keeping the file's existing TTL |
| `rename(from, to, cb)` | Keeps the TTL unless a new one is given |
| `truncate(file, [length], cb)` | Truncates to `length` (default 0) |
| `unlink(file, cb)` | Deletes |
| `temporary` | Listed for DataPower, but undocumented; throws a clear error |

All calls are asynchronous with `(error, result)` callbacks. Without a callback they return a Promise. Errors carry `errorMessage` and a `code` (`ENOENT`, `EACCES`, `EINVAL`).

**Where files can go:**

- Reads from `local:///`, `store:///` and `temporary:///`.
- Writes to `temporary:///` only. That's the only writable directory the sources mention, and IBM documents the TTL as valid only there. Writing elsewhere fails with `EACCES`. If your appliance allows more, set `new Gateway({ fsWritable: ['temporary', 'local'] })`.
- Paths can't climb out of their directory with `..`.

**Time-to-live.** A file written to `temporary:` lives for `TTL` seconds: from 0 to 86400, **default 10**, and **0 keeps it**. Both ways of passing it work:

```js
fs.writeFile({ file: 'temporary:///token.json', TTL: 300 }, data, cb);
fs.writeFile('temporary:///token.json', data, { TTL: 300 }, cb);
```

A negative or non-integer TTL is a `RangeError`. Above 86400 is accepted with a warning, matching a community report from real firmware.

**Across transactions.** As on the appliance, `temporary:///` outlives the transaction: every run of the same `Gateway` shares one folder, so a token cached in one run is readable in the next. Set `temporaryDir` to choose the folder, and replace `gw.now` to move time forward in tests:

```js
const gw = new Gateway({ localDir: 'local' });
await gw.run('local:///main.js');            // caches a token with TTL 300
gw.now = () => Date.now() + 301 * 1000;      // five minutes later...
await gw.run('local:///main.js');            // ...the cache has expired
```

**Not known from the sources**, so treat the simulator's choice as an assumption:

- the exact parameter order of the "second form" of `writeFile`, `appendFile`, `readFile` and `rename` (both likely shapes are accepted);
- whether `exists` calls back with `(exists)` or `(err, exists)` (both are supported);
- what `fs.temporary` does.

If you can check any of these on your appliance, the fix is a few lines in `lib/modules/fs.js`.

## API Connect

In the API gateway's GatewayScript assembly action, some modules are withheld:

- **10.0.1.x:** `fs`, `mgmt` and `policy-utility` (IBM's 10.0.x programming-model page).
- **10.5.0 and later:** only `policy-utility`, according to an IBM community answer.

The simulator doesn't apply these restrictions. If a script must also run as an API Connect policy, avoid `policy-utility`.

## Language level

IBM's 10.0.x page describes GatewayScript as supporting ECMAScript 2015 features (promises, generators, template strings), aligned with Node.js 8.9.4, and requires **strict mode**. The simulator runs your code in a much newer Node and doesn't force strict mode, so syntax or sloppy-mode code that works here (an undeclared variable, newer syntax) can still fail on the appliance. The Node.js version inside 10.5.0.19 isn't stated in the sources consulted.

## Sources

- Hermann Stamm-Wilbrandt, [DataPower GatewayScript cheat sheet: supported objects, modules, and methods](https://stamm-wilbrandt.de/en/blog/DataPower.GatewayScript.CheatSheet.pdf). The fullest module and method list found, including `fs`, `util`, `crypto`, `jose`, `jwk` and `policy-utility`. Undated.
- IBM, [DataPower 10.0.x: Gateway programming model and GatewayScript](https://www.ibm.com/docs/en/datapower-gateway/10.0.x?topic=gateway-programming-model-gatewayscript). DataPower module list, language level, and API gateway restrictions.
- IBM, [datapower-playground API docs](https://github.com/ibm-datapower/datapower-playground) (`src/web/public/doc/api`), including `sprintf`, `util`, `querystring`, `url` and `punycode`, and [datapower-samples](https://github.com/ibm-datapower/datapower-samples) for real `require` usage.
- IBM community: [about TTL in fs module](https://community.ibm.com/community/user/integration/discussion/about-ttl-in-fs-module-gatewayscript), which quotes IBM's `fs` page on TTL; [how to call file using fs module in APIC](https://community.ibm.com/community/user/discussion/how-to-call-file-using-fs-module-in-apic), with `fs.readAsJSON` usage; [module usage restriction in API Connect](https://community.ibm.com/community/user/discussion/module-usage-restriction-in-apiconnect-gateway-script), with restrictions by version; [rewrite json value in a file](https://community.ibm.com/community/user/discussion/rewrite-json-value-in-a-file-to-be-accessed-in-future-transactions), with `system-metadata` usage.
- IBM APARs [IT30858](https://www.ibm.com/support/pages/apar/IT30858) and [IT46135](https://www.ibm.com/support/pages/apar/IT46135), on `fs` TTLs for `temporary:` files, and [IT21005](https://www-01.ibm.com/support/docview.wss?uid=swg1IT21005), on `fs.readAsJSON()` with large files.
- IBM, [Introducing DataPower GatewayScript (7.0)](https://public.dhe.ibm.com/software/iea/content/com.ibm.iea.wdatapower/wdatapower/1.0/xi52/DataPower_70_GatewayScript.pdf). The original module set; before `fs` existed, file access was only through `urlopen`.
