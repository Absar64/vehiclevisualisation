# fonts/

The boot greeting is set in **Billion Dreams Bold**.

It is a commercial typeface, so the file is not bundled and is not downloaded
at build or run time. Supply your own licensed copy.

## Adding it

Drop the file in this folder under one of these names — the stylesheet tries
them in this order, best format first:

```
fonts/BillionDreams-Bold.woff2
fonts/BillionDreams-Bold.otf
fonts/BillionDreams-Bold.ttf
```

Until one of them exists the browser requests all three and logs a 404 for
each. That is expected, it breaks nothing, and it stops as soon as a file is
there — or if the font is installed on the machine, because a matching
`local()` source means no URL is requested at all.

`.woff2` is worth converting to: it is roughly half the size of the `.otf` or
`.ttf` you will have bought, and it is the only format every current browser
prefers. Any font converter will do it, or `fonttools`:

```bash
pip install fonttools brotli && fonttools ttLib.woff2 compress BillionDreams-Bold.otf
```

## Or just install it

The `@font-face` rule in `src/styles.css` lists `local()` sources first, so if
Billion Dreams Bold is installed on the machine the greeting picks it up with
no file here at all. That works for local viewing; a deployed copy needs the
file in this folder, since visitors will not have it installed.

## If it is missing

Nothing breaks. The greeting falls back to the platform UI face — San
Francisco on Apple hardware, Roboto elsewhere. The `font-size` in `.welcome`
is tuned for the script's small x-height, so the fallback renders noticeably
larger than it should; that is the visible sign the font has not been found.
