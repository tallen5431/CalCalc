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

Everything the camera read can be corrected in that same sheet. OCR gets the odd
line wrong and the person holding the box can see which one; a blank field means
"use what was scanned".

**⌨ Type** is the same arithmetic with no camera involved. It works on plain
http, on a desktop, and on a panel too crumpled to read.

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

| Frame | Read time | Result |
|---|---|---|
| Clean render | ~1.9s | correct |
| 4° angle, 1.1px blur, mild glare | ~1.5s | correct |
| Half resolution | ~1.9s | correct |
| 6° angle, heavy glare, low contrast | ~1.4s | correct, minus the servings count |

The last row is the interesting one. Glare turned the "8" of "8 servings per
container" into a "g", and the reader left the field **empty** rather than
guessing — see below. Calories, serving size and calories per gram were right on
every frame.

Two agreeing reads are required before a verdict is trusted, so call it **2–4
seconds** to a confirmed answer on phone-class hardware.

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

The first two are the dangerous ones: both produce a complete, plausible number
from a line the engine otherwise read perfectly. `Calories 2 30` read naively is
**2 calories**.

## It needs HTTPS for the camera

Browsers only hand out a camera in a *secure context*: HTTPS, or `localhost`.
Over plain http on a LAN address — `http://192.168.1.20:8090/scan.html` — there
is no camera to open at all, and the page says so rather than failing quietly.
**📷 Photo** and **⌨ Type** still work there.

### Over Tailscale (recommended — nothing to install on the phone)

Tailscale issues a real, publicly-trusted certificate for your machine's
MagicDNS name, which means no warning, no CA to install, and the offline
home-screen install works too. From this directory:

```sh
sudo tailscale serve --bg 8090
```

Then open `https://<your-machine>.<your-tailnet>.ts.net/` on the phone. It works
from anywhere on the tailnet — the shop as much as the kitchen — and nothing is
exposed publicly.

`server.js` looks this up at startup and prints the exact URL to open, so you do
not have to remember your tailnet name. When the camera is blocked, `/scan.html`
asks the server the same question and puts the working address **on screen as a
link**, rather than telling you that cameras need HTTPS and leaving you there.

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

Camera frames are read and discarded. No image is stored or transmitted, the OCR
engine and its language model are vendored locally, and the app makes no network
request after it loads. Prices and corrections are kept in `localStorage` on the
phone. There is no account and no server-side record of anything scanned.

## Tests

```sh
npm test                        # 115 checks, no browser, no dependencies
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
| `tests/e2e.js` | The real pipeline, in a real browser |

## Notes

The serving size on a package is a marketing decision as much as a nutritional
one, which is the reason this app leads with calories per gram: it is the one
figure a manufacturer cannot move by redefining what a serving is. Calories per
dollar is the same idea applied to the shelf edge — a bigger box is not cheaper
food until you have divided.
