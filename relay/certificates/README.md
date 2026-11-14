# Public intermediate certificates

Fetched 2026-10-23 over verified HTTPS from Let's Encrypt's [official chain documentation](https://letsencrypt.org/certificates/):

- `int-ye1.pem`: https://letsencrypt.org/certs/gen-y/int-ye1.pem
- `root-ye-by-x2.pem`: https://letsencrypt.org/certs/gen-y/root-ye-by-x2.pem

The game endpoint observed at `25ca.s.m28n.net` presented only its leaf certificate, issued by YE1, and failed ordinary Node TLS verification with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.

These files complete `leaf -> YE1 -> Root YE (cross-signed) -> ISRG Root X2`. Harbor verifies each added intermediate's signature and validity against the pre-existing trusted root set. It rejects new self-signed roots and disconnected chains. Target hostname, date, chain and certificate verification stay enabled. No OS trust settings are modified.

SHA-256 certificate fingerprints:

```text
YE1: A2:37:2D:06:43:1E:97:16:36:5E:EE:D4:7E:C0:20:35:14:97:D1:82:FC:C0:38:E4:57:E5:81:68:A0:3C:AC:07
Root YE cross-signed by X2: 0F:C0:90:1C:CA:2B:AE:9E:9F:DB:B0:2D:50:D0:2F:10:94:F7:B3:66:72:08:69:91:B9:E8:97:62:6D:C4:85:F0
```

Expired intermediate certificates are ignored. This is not a universal automatic missing-chain fetcher.
