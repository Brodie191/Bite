# Bite

Bite is a static photography site built with plain HTML, CSS and JavaScript. It has no build step and no dependencies.

## Running it locally

Serve the `bite/` folder over HTTP. Don't open the HTML files straight from disk (`file://`). On `file://` the browser blocks `fetch`, so two features stop working:

- **The sound mixer:** the audio layers in `media/layers/` never load.
- **Page swapping:** links do a full page reload, which cuts the audio off whenever you change pages.

Use any one of these options.

### Python (preinstalled on macOS)

```sh
cd bite
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

### Node

```sh
npx serve bite
```

Then open the URL it prints, usually <http://localhost:3000>.

### VS Code

Install the **Live Server** extension. Open `bite/index.html`, then click **Go Live** in the status bar.

Press `Ctrl+C` in the terminal to stop the Python or Node server.

## Project layout

```
bite/
  index.html      Home
  gallery.html    Gallery
  look.html       The Look
  contact.html    Contact
  css/style.css   Styles
  js/main.js      Sound mixer and page swapping
  images/         Photos
  media/layers/   Audio layers for the mixer
Spec/             Requirements spec (.tex and .pdf)
```

## Testing

Run the W3C validators on every page and the stylesheet:

```sh
./validate.sh
```

It sends the files to [validator.w3.org](https://validator.w3.org/nu/) and the [CSS validator](https://jigsaw.w3.org/css-validator/), then prints any errors with line numbers. It exits with 0 when everything passes. The 40 or so "CSS variables are not statically checked" notices are expected and are counted separately.

W3C doesn't check JavaScript, accessibility or layout. Check those in Chrome DevTools (`Cmd+Option+I`):

- **Console:** click through every page, play the sound and open the mixer. Fix anything shown in red.
- **Lighthouse:** run it on each page and aim for an Accessibility score of 95 or higher.
- **Device mode** (`Cmd+Shift+M`): set the width to 360. The page should never scroll sideways.
