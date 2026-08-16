# CalCalc

Point a phone at a Nutrition Facts panel and get the two numbers the panel does
not print:

- **calories per gram** — how dense the food is, independent of how big the
  package decided a serving should be
- **calories per dollar** — once you type what the package costs

Built the same way as [Uber Scan](https://github.com/tallen5431/Uber_Scan): a
live camera scan with the OCR engine vendored into the page, a typed screen that
works with no camera at all, and a zero-dependency Node server that drops into
the [HTTP Server Manager](https://github.com/tallen5431/HTTP_Server).

## Using it

Open `/scan.html`, line the box up on the panel, hold still. The frame turns
green when the reading is confirmed and the number stops moving.

Tap **💲 Price**, type what the package costs, and the second figure appears.
The price is remembered per device, not per product, so it is one field to
retype rather than a database to maintain.

### When the camera cannot work something out

Everything the camera reads can be typed instead, in that same **💲 Price**
sheet — calories, serving size, servings per container, and the package mass.
OCR gets the odd line wrong and the person holding the box can see which one; a
blank field means "use what was scanned".

Weights carry their own unit, so you type what is printed on the package rather
than converting first:

| Field | Units |
|---|---|
| Serving size | g, mL, oz |
| Package mass | g, kg, mL, oz, lb |

**Package mass is the way round a missing servings count.** Calories per dollar
needs to know how much is in the package, and the servings line is the part of
the panel most often lost to glare. If it will not read, type the net weight off
the front of the package instead — `NET WT 16 OZ` — and the container total comes
from that and the density. The screen says which of the two it used.

Changing a unit re-reads the number beside it, so switching g to oz updates the
answer without retyping. **CLR** clears the numbers but keeps the units: working
along a shelf of drinks, you set mL once.

**⌨ Type** is the same arithmetic with no camera involved. It works on plain
http, on a desktop, and on a panel too crumpled to read.

## Keeping what you find

**💾 Save this** appears under the readout once there is a reading. Give the item
a name and it goes into the record; **▤ Saved** is the list.

A single scan answers "what am I holding". The list answers the question the
record exists for — *which of these is the better buy* — so it sorts, and the
best calories per dollar is badged wherever it happens to sit:

| Sort | |
|---|---|
| Best cal/$ | the most food for the money |
| Densest | the most calories per gram |
| Cheapest | lowest $ per 1000 calories |
| Newest | in the order you found them |

Each row carries **how the reading was made** — `macros agreed`, `calories
corrected`, `unit assumed`, `typed`, `pack size from mass`. A saved number with
no record of how much to trust it cannot be checked a month later, when the
package it came from is in a bin.

**⤓ CSV** exports the lot for a spreadsheet.

### It saves in the shop, not just at home

The record lives on the server, but the phone standing in the aisle is often out
of range of it. A save is written to the phone first and sent afterwards, so
nothing is lost to a basement with no signal — the screen says *"Kept on this
phone — 1 waiting to reach the server"* rather than claiming a save that has not
happened, and it goes out the next time the page can reach the server. Every
entry carries an id generated on the phone, so a retry lands on the same row
instead of filing a second copy.

### Nothing is deleted

**Hide** appends a note rather than removing a line; hidden items are out of the
list and the export until **Show hidden** is ticked, and can be unhidden. A
mis-tap on a phone in a shop should cost an entry in a list, not a record.

The file is `data/journal.jsonl` — one JSON object per line, appended, never
rewritten, so a power cut costs at most the line being written. The server
refuses to serve `data/` at all; the page reads it through `/api/items`. Set
`JOURNAL=/some/path.jsonl` to put it elsewhere.

## The math

```
calories per gram = calories per serving / serving size in grams

container calories = calories per serving x servings per container
calories per dollar = container calories / price
$ per 1000 cal     = price / (container calories / 1000)
```

When the servings line is unreadable but a net weight is on the package, the
container total comes from the net weight and the density instead. The screen
says which of the two it used, because they are not equally trustworthy.

A drink that measures its serving in millilitres is reported per millilitre and
labelled that way. Converting mL to grams needs a density the panel does not
give, and inventing one would put a made-up number in the denominator of the
headline.

## Does it work?

Yes, on rendered panels degraded the way a phone camera degrades them — held at
an angle, slightly out of focus, with a glare band across the packaging.
`tests/e2e.js` runs the real shipping pipeline: canvas preprocessing, Tesseract,
the parser, the arithmetic.

Two panel layouts are tested, because they are not variations on a theme:

- **the table** — the FDA's example panel, the one on most boxes
- **the linear panel** — the same information as one running sentence, which is
  what a gallon jug or a small package prints when there is no room for the
  table. Abbreviated (`Serv. size`), no "per container" anywhere, a serving in
  millilitres, and a comma after every number.

| Frame | Table | Linear |
|---|---|---|
| Clean render | correct | correct |
| 4° angle, 1.1px blur, mild glare | correct | correct |
| Half resolution | correct | correct |
| 6° angle, heavy glare, low contrast | correct¹ | correct² |
| **Side-on package (90°)** | correct | correct |
| **Side-on the other way (270°)** | correct | correct |
| **Upside down (180°)** | correct | correct |

¹ minus the servings count · ² minus fat and carbohydrate

Those two footnotes are the interesting part. Glare turned the "8" of "8
servings per container" into a "g" on one panel and ate the word "Total" from
two macro lines on the other, and in both cases the reader left the field
**empty** rather than guessing — see below. Calories, serving size and calories
per gram were right on every frame of both layouts.

Two agreeing reads are required before a verdict is trusted, so call it **2–4
seconds** to a confirmed answer on phone-class hardware.

### Which way up

A Nutrition Facts panel is usually printed on the *side* of a package, so a
phone held normally sees it lying on its side — and sideways text gives the
reader **nothing at all**. Not a poor reading: calories, serving size and every
macro come back empty at 90°, 180° and 270°. It is the single largest reason a
label fails to scan, and it looks exactly like the app being broken.

So the scanner turns the frame. It sticks to whichever way up last worked, and
only goes looking again after several failed reads — so a shelf of side-printed
packages costs one probe rather than one per frame, and a panel that has merely
drifted out of focus does not send it hunting. The box on screen turns with it,
and the status line says `sideways` so it is clear what is being read.

**📷 Photo** reads all four ways up and keeps the best, stopping early on a
reading the macros confirm. A photo taken sideways — which is how most people
photograph the side of a box — reads correctly with nothing to do.

## What stops it being confidently wrong

A scanner that is sometimes wrong and always certain is worse than no scanner,
because you cannot tell the readings apart. Three things guard against it.

**The panel checks itself.** A Nutrition Facts panel states its calories *and*
the macros those calories are made of, which is two independent readings of the
same quantity:

```
calories ≈ 9 × fat + 4 × carbohydrate + 4 × protein
```

The reference panel says 230 and its own macros come to 232. So a calorie figure
that survives this has been checked against a second source on the same label —
and one that does not, says so on screen. When a digit has been lost or gained,
the powers of ten around the reading are tried against the macros, and a
correction is made **only if exactly one of them fits**, so an ambiguous reading
stays ambiguous instead of being quietly resolved. Every correction is shown.

If the calorie line is unreadable but the macros are not, the macros stand in —
labelled as having come from the macros, never presented as read off the panel.

**Nothing edible beats 9 calories per gram.** That is pure fat, by definition. A
serving weight misread as 5g instead of 55g makes a breakfast cereal denser than
lard, so the digit is restored when exactly one power of ten lands somewhere
believable, and the density is simply **not shown** when none does. Cooking oil
at exactly 9.0 cal/g still passes.

**A missing number is fine; a wrong one is not.** This is the rule the whole
thing is built on. Absent fields are visible on screen with a box to type them
into. A wrong servings count is invisible and multiplies straight through into
calories per dollar — which is the number being used to choose between two boxes
on a shelf. So when glare turned that "8" into a "g", the lookalike table could
have made it a "9" and been wrong by an eighth with nothing admitting it. It is
left empty instead, and the app asks.

### What the camera actually gets wrong

Measured on the harness, not guessed — and each one cost a real bug before it
was handled:

| What happens | Example | Why |
|---|---|---|
| The gram unit becomes a digit | `(55g)` → `(559)` | A lowercase "g" is a closed loop with a descender. This is a "9". |
| The calorie figure splits | `Calories 230` → `Calories 2 30` | It is set in the largest type on the panel, and large type is where the engine inserts spaces. |
| Glare invents accents | `Serving size` → `Serving sizé` | A rule above the line lands on the letter. |
| The macro units go too | `Total Fat 8g` → `Total Fat 89` | Same "g", under worse contrast. |
| "Total" is eaten | `Total Fat 8g` → `Fat 8g` | Leaves the sub-line (`Sat. Fat 5g`) as the only fat line the reader can see. |
| The "g" arrives twice | `Total Carb. 12g` → `129g` | The unit is read as a digit *and* kept, giving an ordinary-looking wrong number. |

The first two are the dangerous ones: both produce a complete, plausible number
from a line the engine otherwise read perfectly. `Calories 2 30` read naively is
**2 calories**.

The last is the same trap one level up. With "Total" gone, `Sat. Fat 5g` is the
only fat line left, and taking it reports 5g where the panel says 8g — a number
that looks entirely reasonable and is wrong. Sub-lines are refused by name, full
stop and all, so the fat comes back **missing** instead.

## It needs HTTPS for the camera

Browsers only hand out a camera in a *secure context*: HTTPS, or `localhost`.
Over plain http on a LAN address — `http://192.168.1.20:8090/scan.html` — there
is no camera to open at all, and the page says so rather than failing quietly.
**📷 Photo** and **⌨ Type** still work there.

### Over Tailscale (recommended — nothing to install on the phone)

Tailscale issues a real, publicly-trusted certificate for your machine's
MagicDNS name, which means no warning, no CA to install, and the offline
home-screen install works too.

**Check what is already there first.** One machine often serves several things,
and whichever is mounted on `/` owns the plain `https://<machine>.<tailnet>.ts.net/`
address:

```sh
tailscale serve status
```

If that comes back empty, the root is free:

```sh
sudo tailscale serve --bg 8090          # -> https://<machine>.<tailnet>.ts.net/
```

**If something else already holds `/`** — an Ollama chat UI, the HTTP Server
Manager, anything — you do **not** have to take it down. Give CalCalc its own
address instead. Either works; the port is the simpler of the two:

```sh
sudo tailscale serve --bg --https=8443 8090        # -> https://<machine>.<tailnet>.ts.net:8443/
sudo tailscale serve --bg --set-path /calcalc 8090 # -> https://<machine>.<tailnet>.ts.net/calcalc/
```

Both leave the existing service exactly where it is. The app is built to run
under a path prefix — every URL in it is relative, and the service worker scopes
itself to wherever it is mounted — so `--set-path` needs no configuration here.

Then open the address on the phone. It works from anywhere on the tailnet — the
shop as much as the kitchen — and nothing is exposed publicly.

`server.js` **asks Tailscale where this app is actually published** rather than
assembling a URL from the hostname, and prints the real address at startup. When
the camera is blocked, `/scan.html` asks the same question and puts that address
on screen as a link — or, if nothing is serving this port yet, the command that
would fix it. It will never hand you a link to whatever else happens to live on
that machine.

### Without Tailscale

```sh
npm run cert       # writes ./ssl, then restart the server
```

https then serves on 8453 *alongside* http on 8090, so nothing pointing at the
old address breaks. The certificate names every LAN address of the machine, and
its tailnet name if it has one.

Accepting the browser's warning is enough for the camera but **not** for the
offline install — Chrome refuses to register a service worker on a certificate
it does not trust. For that, install `ssl/ca.pem` on the phone:

- **Android** — Settings → Security → More security settings → Encryption &
  credentials → Install a certificate → CA certificate
- **iOS** — open the file, install the profile, then Settings → General → About
  → Certificate Trust Settings and enable full trust

Re-running `npm run cert` reuses the existing authority, so the phone only ever
has to trust one.

## Running it under the HTTP Server Manager

Drop this folder into the manager's `projects/` directory and hit **Rediscover**
— `Start.sh` is in the root, which is what the manager scans for, and it reads
`PORT` straight out of that script.

To have the card link to the Tailscale HTTPS address instead of a LAN IP, add it
to the manager's `config.json` like this:

```json
{
  "id": "calcalc",
  "name": "CalCalc",
  "path": "/home/user/HTTP_Server/projects/CalCalc",
  "env": { "HOST": "0.0.0.0", "PORT": "8090" },
  "urlProtocol": "https",
  "preferTailscale": true,
  "omitPortInUrl": true,
  "autostart": true
}
```

`omitPortInUrl` is the one that matters: `tailscale serve` proxies 443 to the
app, so the URL must have no port on it. `autostart` is worth setting — the
point of this app is that it is already running when you are standing in a shop.

That config assumes CalCalc is on the **root** of the tailnet name. If something
else is (see above), those three URL fields will generate an address that opens
the other app, so set the real one explicitly instead:

```json
"url": "https://your-machine.your-tailnet.ts.net:8443",
```

or, for a path mount, `"url": "https://your-machine.your-tailnet.ts.net/calcalc/"`.
A manual `url` overrides the generated one. `server.js` prints the correct
address at startup if you are not sure which you ended up with.

If the `tailscale` CLI is not on the manager's PATH, set `tailscaleHostname` at
the root of its config, or `TAILSCALE_HOSTNAME` in the environment. This server
reads the same two variables.

## Running it directly

```sh
./Start.sh          # or: npm start, or: node server.js
```

Then open `http://localhost:8090`. `PORT=3000 npm start` to move it. There are
no dependencies to install — `server.js` is plain Node with a zero-install
static file server, and it is what `package.json` points `main` and `start` at.

**If your host tried to run `ui.js` or `scan.js` with Node and died on
`ReferenceError: document is not defined`**, that is the symptom of this project
being executed rather than served. Everything in it except `server.js` and the
files under `tools/` and `tests/` is browser code, and Node has no `document`.
Point the host at `server.js`, or let it read `package.json`, and it will serve.

## Installing on a phone

Over HTTPS the app installs to the home screen and runs full screen with no
browser chrome:

- **iPhone (Safari):** Share → *Add to Home Screen*. Must be Safari; Chrome on
  iOS cannot install it.
- **Android (Chrome):** the *Install app* prompt, or ⋮ → *Add to Home screen*.

The OCR engine is cached on first use, so after that it reads labels in a shop
with no signal. `vendor/` is ~15MB in the repo so that any phone gets a core
build it can run; a given phone downloads only the ~4MB variant it needs, once.

## Privacy

**Camera frames are read and discarded.** No image is ever stored or
transmitted. The OCR engine and its language model are vendored locally, so the
reading happens on the device and needs no network at all.

**Saved items do go to the server** — that is what makes them a record rather
than something a cleared browser takes with it. They go to *your* server, the
one running this code, and nowhere else: there is no account, no third party,
and no telemetry. What lands in `data/journal.jsonl` is what you named and the
numbers on screen. Prices, corrections and anything not yet synced stay in
`localStorage` on the phone.

Worth knowing what that file is: a list of what you buy, what it costs and when
you were shopping. It is gitignored, the server refuses to serve the directory,
and `JOURNAL=` moves it. Nothing in this app writes anywhere else.

**The server has no authentication**, which is defensible on a tailnet — only
your own devices can reach it — and is why it should not be exposed publicly.
Anyone who can reach the port can add an entry to the list. Nothing they add can
destroy or rewrite one.

A browser, though, cannot be turned into that reach. Writes require
`Content-Type: application/json`, which makes them non-simple requests: a page on
some other site cannot send one without a CORS preflight first, and this server
answers preflights with 405 and no CORS headers. Without that requirement, any
site you happened to open while your phone was on the tailnet could have written
rows into the journal with a plain form POST — measured, not theorised.

## Tests

```sh
npm test                        # 312 checks, no browser, no dependencies
```

The end-to-end harness needs a browser and is deliberately not part of that:

```sh
npm i -D playwright && npx playwright install chromium
npm start &
E2E_URL=http://localhost:8090 node tests/e2e.js
E2E_DEBUG=1 ...                 # also prints what the reader handed the parser
CHROMIUM_PATH=/path/to/chrome   # use a Chromium already on the machine
```

`E2E_DEBUG=1` is the first thing to reach for when a real package will not read:
it shows whether the problem is the camera, the engine, or the patterns.

## What the server will not serve

`server.js` has no authentication. On a tailnet that is defensible — only your
own devices can reach it — and over a LAN it means every file under the project
root is one GET away from anyone on the same wifi. That is fine for a page of
HTML and not fine for `ssl/ca-key.pem`, which is the private key of the
authority `make-cert.sh` asks you to install on your phone as a trust anchor.
Anyone who fetched it could mint a certificate your phone would believe, for any
site.

`ssl/`, `node_modules/`, dotfiles and anything ending `.pem`/`.key`/`.crt` are
refused outright, and paths are re-checked after following symlinks rather than
only being resolved lexically — resolving a path proves nothing about where a
link inside the root actually points.

## Files

| Path | |
|---|---|
| `index.html` `ui.js` | The typed calculator |
| `records.html` `records.js` `records.css` | Everything saved, and the orders to read it in |
| `save.js` | Saving a named item, with the offline queue |
| `journal.js` | What may go into the record, and how it exports |
| `scan.html` `scan.js` `scan.css` | The camera scanner |
| `label-parser.js` | Reads a panel, and the arithmetic — browser and Node both |
| `styles.css` | Shared styling |
| `server.js` | Zero-dependency static server; the Node entry point |
| `Start.sh` | What the HTTP Server Manager looks for |
| `sw.js` | Offline cache — bump `CACHE` when you change files |
| `manifest.webmanifest` | Home-screen install metadata |
| `tools/make-cert.sh` | `npm run cert` — local certificate authority for https |
| `tools/make-icons.js` | `npm run icons` — regenerates `icons/` |
| `tests/parser.test.js` | The reading and arithmetic, headless |
| `tests/serve.test.js` | Where `tailscale serve` publishes this app |
| `tests/journal.test.js` | What the record accepts, collapses and exports |
| `tests/e2e.js` | The real pipeline, in a real browser, on both panel layouts |

## Notes

The serving size on a package is a marketing decision as much as a nutritional
one, which is the reason this app leads with calories per gram: it is the one
figure a manufacturer cannot move by redefining what a serving is. Calories per
dollar is the same idea applied to the shelf edge — a bigger box is not cheaper
food until you have divided.
