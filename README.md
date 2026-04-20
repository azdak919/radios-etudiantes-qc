# CHYZ+

CHYZ+ is a lightweight Progressive Web App for listening to CHYZ 94.3 FM, checking the current schedule, and following Universite Laval news from a mobile-first interface.

Live site:
`https://azdak919.github.io/radios-etudiantes-qc/`

This is an unofficial fan companion for CHYZ 94.3 FM and Universite Laval content. It is not affiliated with CHYZ or Universite Laval.

## What It Includes

- Secure live audio playback using CHYZ's public HTTPS stream
- PWA install support with `manifest.json` and `sw.js`
- Lock-screen / media-session controls on supported browsers
- Dynamic CHYZ schedule parsing from `https://chyz.ca/horaire/`
- Previous / current / next / after-next show cards based on Quebec time
- Campus news feed combining ULaval Nouvelles and several ULaval association RSS feeds
- Offline shell caching plus cached schedule/news snapshots

## Project Structure

- `index.html` - app shell and layout
- `style.css` - custom styles layered on top of Tailwind CDN
- `app.js` - player logic, install flow, and now-playing state
- `schedule.js` - CHYZ schedule fetch/parsing and current-show timeline logic
- `news.js` - ULaval/news feed aggregation and rendering
- `data-utils.js` - shared fetch, time, parsing, and formatting helpers
- `manifest.json` - PWA manifest
- `sw.js` - service worker for app-shell caching
- `assets/` - icons and branding assets

## Local Development

Because this is a static site, any simple local web server is enough.

Example:

```bash
cd radios-etudiantes-qc
python -m http.server 8080
```

Then open:
`http://localhost:8080/`

## Data Sources

- CHYZ stream and schedule: `https://chyz.ca/`
- Schedule page: `https://chyz.ca/horaire/`
- ULaval Nouvelles: `https://nouvelles.ulaval.ca/`
- ULaval association feeds discovered from the public ULaval associations directory/API

## Notes

- The app prefers live stream metadata when it is available.
- If stream metadata is missing or generic, the player falls back to the currently scheduled CHYZ show.
- External content sources can change structure over time, so schedule/news parsing should be treated as a maintained integration rather than a fixed API contract.
