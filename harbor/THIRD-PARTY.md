# Third-party software

Harbor's source is distributed under AGPL-3.0-only. Dependencies remain under their own licenses. This package includes source and a dependency lockfile; npm retrieves the actual dependencies during installation.

| Package | Purpose | Upstream |
|---|---|---|
| @mercuryworkshop/scramjet | Page rewriting and browser API adaptation | https://github.com/MercuryWorkshop/scramjet |
| @mercuryworkshop/scramjet-controller | Frame management and persisted cookie state | https://github.com/MercuryWorkshop/scramjet |
| @mercuryworkshop/libcurl-transport | Client-side HTTP/TLS over Wisp | https://github.com/MercuryWorkshop/CurlTransport |
| @mercuryworkshop/epoxy-transport | Alternative client-side HTTP/TLS transport | https://github.com/MercuryWorkshop/EpoxyTransport |
| libcurl.js | WebAssembly networking used by the transport | https://github.com/ading2210/libcurl.js |
| @mercuryworkshop/wisp-js | Relay implementation | https://github.com/MercuryWorkshop/wisp-js |
| express | HTTP application and static assets | https://expressjs.com/ |
| impit | Browser-matched TLS/HTTP2 fingerprints for outgoing HTTPS | https://github.com/apify/impit |
| ws | Test-room WebSockets and the native socket relay | https://github.com/websockets/ws |
| ipaddr.js | Resolved destination classification | https://github.com/whitequark/ipaddr.js |
| puppeteer-core | Development browser verification | https://pptr.dev/ |
| Outfit (font, OFL-1.1) | Interface typeface, bundled in `fonts/` with its license | https://github.com/Outfitio/Outfit-Fonts |
| JetBrains Mono (font, OFL-1.1) | Address typeface, bundled in `fonts/` with its license | https://github.com/JetBrains/JetBrainsMono |

See the installed packages' license notices for their complete terms and transitive dependencies. Harbor does not redistribute digdig.io or MCdle assets in its source package; the launchers request those sites from their respective operators.
