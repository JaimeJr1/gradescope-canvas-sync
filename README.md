# gradescope-canvas-sync

Firefox extension. Every hour it reads your Gradescope dashboard and creates a
Canvas Planner To-Do note per open assignment at gatech.instructure.com, then
checks the note off when you submit. Notes show in the Canvas To-Do sidebar,
Planner, Calendar and the BetterCanvas due card.

## Run from source

    npm install
    npm run build
    npm start          # temporary Firefox profile with the extension loaded

Sign in to Gradescope and Canvas in that window, click the toolbar icon,
press "Sync now" (the first press also asks Firefox to allow site access to
both sites; Firefox 115–126 do not grant it at install). Fix course matches
under "Course mapping…".

Notes carry the Gradescope assignment URL in their details, so after a
reinstall or a fresh profile the extension adopts its existing notes instead
of creating duplicates. Checking a note off or deleting it in Canvas is
respected: a deleted note is never recreated.

## Install permanently

    npx web-ext build -s dist

Load the resulting zip via `about:addons` → gear → Install Add-on From File
(requires `xpinstall.signatures.required=false` in `about:config` on
Developer Edition or Nightly), or submit it to AMO for signing.

## Badge

- `!` red: signed out of Gradescope or Canvas. Sign in, then Sync now.
- `?` grey: some other error; open the popup for the message.

## Tests

    npm test
